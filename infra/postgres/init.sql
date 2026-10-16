-- Runs once, the first time the Postgres container starts with an empty volume.
-- Separate database for integration tests so they never touch dev data.
CREATE DATABASE supportpilot_test;
