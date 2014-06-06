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

var cpus = os.cpus().length + '';

module.exports = _.bindAll({
  localSource: false,
  localDest: false,
  sourceCores: cpus,
  destCores: cpus,
  sourceOpts: '',
  destOpts: '',
  dumpDir: '',
  verbose: false,
  skipDrop: false,
  skipTables: [],

  /**
   * Initialize drush, set default options.
   *
   * @param {string} source
   *   The source alias.
   * @param {string} dest
   *   The destination alias.
   * @param {boolean} verbose
   *   (optional) Flag to print more info on dumps. Default false.
   * @param {boolean} skipDrop
   *   (optional) Flag to skip dropping destination tables. Default false.
   * @param {array} skipTables
   *   (optional) An array of tables to skip the import of. Default [].
   *
   * @return promise
   *   Resolved when drush has been initialized.
   */
  init: function (source, dest, verbose, skipDrop, skipTables) {
    var d = new Date();
    source = source;
    dest = dest;
    this.dumpDir = path.join(os.tmpdir(), d.getTime() + '-' + source + '-' + dest);
    fs.mkdir(this.dumpDir);
    this.sourceOpts = {
      alias: source
    };
    this.destOpts = {
      alias: dest
    };
    this.verbose = verbose || this.verbose;
    this.skipDrop = skipDrop || this.skipDrop;
    this.skipTables = skipTables || this.skipTables;
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
    if (this.skipDrop) {
      var def = new promise.Deferred();
      def.resolve();
      return def;
    }

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
      .then(function (tables) {
        tables = tables.split(require('os').EOL);
        // HACK - it looks like drush-node is adding a table named '.'
        // to the end. It might just be something from stdout but it's
        // blowing up this process exiting correctly.
        var pullArgs = [tables, '.', ''];

        // If we're skipping other tables, add those too.
        if (this.skipTables) {
          pullArgs = _.union(pullArgs, this.skipTables);
        }

        // Remove tables we don't want to import.
        _.pull.apply(this, pullArgs);

        var barString = 'Reloading ' + this.destOpts.alias + ' [:bar] :percent in :elapseds';
        var bar = new PB(barString, { total: tables.length, width: 20 });

        var iq = async.queue(this.importWorker, this.destCores);
        var dq = async.queue(this.dumpWorker, this.sourceCores);

        dq.pause();
        dq.drain = function () {
          iq.drain = function () {
            def.resolve();
          };
        };

        tables.forEach(function (table) {
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
      }.bind(this));

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
    if (this.verbose) {
      console.log('Importing ' + task.res.table + '.');
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
      function (res) {
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
      }.bind(this),
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
    return function () {
      var def = new promise.Deferred();
      if (this.verbose) {
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
    }.bind(this);
  },

  /**
   * Tasks to run after the import process is complete.
   *
   * @return promise
   *   Resolved when tasks are complete.
   */
  after: function () {
    rimraf(this.dumpDir, function (err) {
      if (err) {
        console.error('The temporary dump directory was not correctly removed.');
      }
    });
    return drush.exec('updb', this.destOpts);
  },

  /**
   * Sets flags about the provided aliases
   *  - if they are in fact local.
   *
   * @param {array<string>} aliases
   *   [0] - Alias information on source
   *   [1] - Alias information on dest
   */
  setAliases: function (aliases) {
    var sourceAlias = aliases[0].toString('binary');
    var destAlias = aliases[1].toString('binary');
    if (!sourceAlias.match(/remote-host/)) {
      this.localSource = true;
    }
    if (!destAlias.match(/remote-host/)) {
      this.localDest = true;
    }
  },

  /**
   * Sets flags to let us know how many cores are available
   *   on source and destination instances
   *
   * @param {array<string>} cores
   *  [0] - CPU information on source
   *  [1] - CPU information on dest
   */
  setCores: function (cores) {
    var sourceCores = cores[0].toString('binary');
    var destCores = cores[1].toString('binary');
    if (sourceCores) {
      this.sourceCores = sourceCores.replace(/\D/, '');
    }
    if (destCores) {
      this.destCores = destCores.replace(/\D/, '');
    }
  }
});

