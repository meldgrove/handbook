// Creates an empty knowledge_e2e database on the PostgreSQL of compose.dev.yaml.
import pg from "pg";

const client = new pg.Client({ connectionString: "postgres://knowledge:knowledge@localhost:55450/postgres" });
await client.connect();
await client.query("drop database if exists knowledge_e2e with (force)");
await client.query("create database knowledge_e2e");
await client.end();
