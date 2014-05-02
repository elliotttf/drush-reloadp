#!/bin/zsh

drush=`which drush`
parallel=`which parallel`
source=$1
dest=$2
wd=`pwd`

if [[ -z $source || -z $dest ]]; then
  echo "Usage: $0 <source.alias> <dest.alias>"
  exit 1
fi

$drush $dest sql-drop -y
tables=`$drush $source sqlq --extra=--skip-column-names "SHOW TABLES"`

if [[ -z $tables ]]; then
  echo "Unable to read tables from $source."
  exit 1
fi

date=`date "+%Y-%m-%d-%H%M"`
dumpDir=/tmp/$date-$source-$dest

mkdir -p $dumpDir

echo "========================================="
echo "Dumping Tables From $source"
echo "========================================="

time echo $tables | $parallel -I %  echo "Dumping table %." \&\& $drush $source sql-dump --tables-list=% --gzip \> $dumpDir/%.sql.gz

echo "========================================="
echo "Importing tables to $dest"
echo "========================================="

cd $dumpDir
time ls -S *.sql.gz | $parallel -I % echo "Importing table %." \&\& gzcat % \| $drush $dest sqlc
cd $wd
rm -rf $dumpDir
