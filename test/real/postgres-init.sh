#!/bin/sh
# Runs once in the fresh Postgres container. Synapse needs C collation.
# bipe_test is the role and database that test/helpers/database.mjs accepts.
set -eu
psql -v ON_ERROR_STOP=1 -U bipe -d bipe <<SQL
CREATE DATABASE synapse WITH TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8';
CREATE DATABASE mas;
CREATE ROLE bipe_test LOGIN PASSWORD '${BIPE_TEST_PASSWORD}';
CREATE DATABASE bipe_test OWNER bipe_test;
SQL
