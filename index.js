#! /usr/bin/env node

var promise = require('promised-io/promise');
var yargs = require('yargs');

// Short circuit if the user wants to get package version.
var argv = yargs.argv;
if (argv.version) {
  var package = require('./package.json');
  console.log(package.version);
  process.exit(0);
}

var argv = yargs
  .usage('$0 -s <source.alias> -d <dest.alias> [-t <table1>[,<table2>...]] [-vr] [--version]')
  .demand([ 's', 'd' ])
  .boolean('v')
  .boolean('r')
  .alias('s', 'source')
  .alias('d', 'dest')
  .alias('v', 'verbose')
  .alias('t', 'skip-tables')
  .alias('r', 'skip-drop')
  .describe('s', 'The source drush alias to dump the database from.')
  .describe('d', 'The destination drush alias to import the database to.')
  .describe('v', "Print more information about what's happening during the process.")
  .describe('t', 'Comma delimited list of tables to skip imports of.')
  .describe('r', 'Skip dropping tables from the destination database.')
  .describe('version', 'Return the version of drush-reloadp.')
  .argv;

var reloadp = require('./lib/reloadp');
promise.seq([
    function init() {
      var skipTables = argv.t ? argv.t.split(',') : [];
      return reloadp.init(argv.s, argv.d, argv.v, argv.r, skipTables);
    },
    reloadp.checkAliases,
    reloadp.setAliases,
    reloadp.getCores,
    reloadp.setCores,
    reloadp.dropTables,
    reloadp.reload,
    reloadp.after
  ])
  .then(
    function done() {
      process.exit(0);
    },
    function doneError(err) {
      console.error(err);
      process.exit(1);
    }
  );

