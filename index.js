#! /usr/bin/env node

var _ = require('lodash');
var async = require('async');
var drush = require('drush-node');
var fs = require('fs');
var os = require('os');
var path = require('path');
var PB = require('progress');
var promise = require('promised-io/promise');
var Stream = require('stream');
var zlib = require('zlib');
var rimraf = require('rimraf');

var cpus = os.cpus().length;

var argv = require('yargs')
  .usage('$0 -s <source.alias> -d <dest.alias> [-v]')
  .demand([ 's', 'd' ])
  .boolean('v')
  .alias('s', 'source')
  .alias('d', 'dest')
  .alias('v', 'verbose')
  .argv;

var reloadp = {
  localSource: false,
  localDest: false,
  sourceCores: cpus,
  destCores: cpus,
  sourceOpts: '',
  destOpts: '',
  dumpDir: '',

  /**
   * Initialize drush, set default options.
   *
   * @param {string} source
   *   The source alias.
   * @param {string} dest
   *   The destination alias.
   *
   * @return promise
   *   Resolved when drush has been initialized.
   */
  init: function (source, dest) {
    var d = new Date();
    this.dumpDir = path.join(os.tmpdir(), d.getTime() + '-' + source + '-' + dest);
    fs.mkdir(this.dumpDir);
    this.sourceOpts = {
      alias: source
    };
    this.destOpts = {
      alias: dest
    };
    return drush.init({
      maxBuffer: (1024 * 1024 * 1024),
      encoding: 'binary'
    });
  },

  /**
   * Determines if a site alias is local or remote.
   *
   * @return promise
   *   Resolved when drush the aliases have been examined for
   *   both the source and destination.
   */
  checkAliases: function () {
    return promise.all([
      drush.exec('sa ' + this.sourceOpts.alias + ' --full'),
      drush.exec('sa ' + this.destOpts.alias + ' --full'),
    ]);
  },

  /**
   * Drops tables from the destination target.
   *
   * @return promise
   *   Resolved when destination tables have been dropped.
   */
  dropTables: function () {
    return drush.exec('sql-drop', this.destOpts);
  },

  /**
   * Returns the number of cores from the source and destination machines
   * so that parallel operations can be limited.
   *
   * @return promise
   *   Resolved when processors have been fetched from both targets.
   */
  getCores: function () {
    var promises = [];
    if (!this.localSource) {
      promises.push(drush.exec('ssh "grep -c ^processor /proc/cpuinfo"', this.sourceOpts));
    }
    else {
      var sourceDef = new promise.Deferred();
      promises.push(sourceDef);
      sourceDef.resolve(new Buffer(this.sourceCores, 'binary'));
    }

    if (!this.localDest) {
      promises.push(drush.exec('ssh "grep -c ^processor /proc/cpuinfo"', this.destOpts));
    }
    else {
      var destDef = new promise.Deferred();
      promises.push(destDef);
      destDef.resolve(new Buffer(this.destCores, 'binary'));
    }

    return promise.all(promises);
  },

  /**
   * Main worker function, dumps tables from the source and imports them
   * into the destination.
   *
   * @return promise
   *   Resolved when all imports have finished.
   */
  reload: function () {
    var def = new promise.Deferred();

    drush.exec('sqlq --extra=--skip-column-names "SHOW TABLES"', this.sourceOpts)
      .then(_.bind(function (tables) {
        tables = tables.split(require('os').EOL);
        // HACK - it looks like drush-node is adding a table named '.'
        // to the end. It might just be something from stdout but it's
        // blowing up this process exiting correctly.
        _.pull(tables, '.', '');

        var barString = 'Reloading ' + this.destOpts.alias + ' [:bar] :percent in :elapseds';
        var bar = new PB(barString, { total: tables.length, width: 20 });

        var iq = async.queue(_.bind(this.importWorker, this), this.destCores);
        var dq = async.queue(_.bind(this.dumpWorker, this), this.sourceCores);

        dq.pause();
        dq.drain = function () {
          iq.drain = function () {
            def.resolve();
          };
        };

        _.each(tables, function (table) {
          dq.push(
            {
              iq: iq,
              fn: this.dumpTable(table),
              bar: bar
            },
            function (err) {
              if (err) {
                def.reject(err);
              }
            }
          );
        }, this);
        dq.resume();
      }, this));

    return def.promise;
  },

  /**
   * Worker callback for the import queue.
   *
   * @param {object} task
   *   The information for the import job, includes:
   *     - res: an object returned from the dump job, includes:
   *       - table: the table to import.
   *       - file: the dump file.
   *     - bar: a progress bar to tick.
   * @param {function} callback
   *   The callback to execute when the import is complete.
   */
  importWorker: function (task, callback) {
    if (argv.v) {
      console.log('Importing ' + task.table + '.');
    }
    drush.exec('sqlc', _.merge(this.destOpts, { cat: task.res.file }))
      .then(
        function() {
          task.bar.tick();
          callback();
        },
        callback
      );
  },

  /**
   * Worker callback for the dump queue.
   *
   * @param {object} task
   *   The information for the dump job, includes:
   *     - fn: the function to execute to run the dump.
   *     - iq: the import queue to append to after the dump.
   * @param {function} callback
   *   The callback to execute after the dump is complete.
   */
  dumpWorker: function (task, callback) {
    task.fn().then(
      _.bind(function (res) {
        task.iq.push(
          {
            res: res,
            bar: task.bar
          },
          function (err) {
            if (err) {
              console.error(err);
              process.exit(1);
            }
          }
        );
        callback();
      }, this),
      callback
    );
  },

  /**
   * Helper method to return a function that will execute a dump.
   *
   * @param {string} table
   *   The table to dump
   *
   * @return function
   */
  dumpTable: function (table) {
    var dumpFile = path.join(this.dumpDir, table + '.sql');
    return _.bind(function () {
      var def = new promise.Deferred();
      if (argv.v) {
        console.log('Dumping ' + table + '.');
      }

      drush.exec('sql-dump --gzip --tables-list=' + table, this.sourceOpts)
        .then(function (res) {
          var gunzip = zlib.createGunzip();
          var rs = new Stream.Readable();
          rs.push(res, 'binary');
          rs.push(null);

          var wStream = fs.createWriteStream(dumpFile);
          wStream.on('finish', function () {
            def.resolve({
              table: table,
              file: dumpFile
            });
          });
          wStream.on('error', function (err) {
            def.reject(err);
          });

          rs.pipe(gunzip)
            .pipe(wStream);
        });

      return def.promise;
    }, this);
  },

  /**
   * Tasks to run after the import process is complete.
   *
   * @return promise
   *   Resolved when tasks are complete.
   */
  after: function () {
    rimraf(this.dumpDir);
    return drush.exec('updb', this.destOpts);
  }
};

reloadp.init(argv.s, argv.d)
  .then(
    _.bind(reloadp.checkAliases, reloadp),
    function(err) {
      console.error(err);
      process.exit(1);
    }
  )
  .then(
    function (aliases) {
      var sourceAlias = aliases[0].toString('binary');
      var destAlias = aliases[1].toString('binary');
      if (!sourceAlias.match(/remote-host/)) {
        reloadp.localSource = true;
      }
      if (!destAlias.match(/remote-host/)) {
        reloadp.localDest = true;
      }
      return reloadp.getCores();
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  )
  .then(
    function (cores) {
      var sourceCores = cores[0].toString('binary');
      var destCores = cores[1].toString('binary');
      if (sourceCores) {
        reloadp.sourceCores = sourceCores.replace(/\D/, '');
      }
      if (destCores) {
        reloadp.destCores = destCores.replace(/\D/, '');
      }
      return reloadp.dropTables();
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  )
  .then(
    _.bind(reloadp.reload, reloadp),
    function (err) {
      console.error(err);
      process.exit(1);
    }
  )
  .then(
    _.bind(reloadp.after, reloadp),
    function (err) {
      console.error(err);
      process.exit(1);
    }
  )
  .then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );

