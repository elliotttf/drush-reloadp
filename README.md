# Drush Reload Parallel

Reloads Drupal databases using [drush](https://github.com/drush-ops/drush) and
inspiration from [mysql-parallel](https://github.com/deviantintegral/mysql-parallel).

### Dependencies

* [GNU Parallel](http://www.gnu.org/software/parallel/)
* [drush](https://github.com/drush-ops/drush)
* [drush aliases](http://drush.ws/examples/example.aliases.drushrc.php)

### Usage

`./reloadp.sh @source.alias @dest.alis`
