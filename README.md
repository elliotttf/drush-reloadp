# Drush Reload Parallel

Reloads Drupal databases using [drush](https://github.com/drush-ops/drush).

This module will dump all the tables from a source database in parallel
and simultaneously begin importing tables into a destination database.
Once the dump and import is complete `drush updb` will be run against the
destination site. This is particularly useful for very large databases that
would otherwise take a long time to dump then import.

## Installation

```bash
$ npm install -g drush-reloadp
```

## Usage

```bash
$ drush-reloadp -s @source.alias -d @dest.alias
```

## Advanced usage

```bash
$ drush-reloadp -s <source.alias> -d <dest.alias> [-t <table1>[,<table2>...]] [-vr] [--version]

Options:
  -s, --source       The source drush alias to dump the database from.                  [required]
  -d, --dest         The destination drush alias to import the database to.             [required]
  -v, --verbose      Print more information about what's happening during the process.
  -t, --skip-tables  Comma delimited list of tables to skip imports of.
  -r, --skip-drop    Skip dropping tables from the destination database.
  --version          Return the version of drush-reloadp.
```

## Caveats

This method sacrifices consistency for speed. If the source database is
receiving new data it's possible to end up with a missing relations for data
that was created on tables that were already imported.

Some strategies to avoid this:

1. Run this code against a low traffic site (i.e. a staging environment).
2. Lock the source site so new content cannot be created.
3. Do nothing – in practice this hasn't been a problem for the sites I've
   used it on.

## License

[MIT](http://opensource.org/licenses/MIT).

## Credits

This module was inspired by [mysql-parallel](https://github.com/deviantintegral/mysql-parallel).

