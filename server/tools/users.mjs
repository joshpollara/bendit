#!/usr/bin/env node
// Managing who can sign in.
//
//   node tools/users.mjs add josh              # prompts for a password
//   node tools/users.mjs add sam --password …  # or takes one
//   node tools/users.mjs list
//   node tools/users.mjs passwd josh
//   node tools/users.mjs remove sam
//
// On the deployed machine:
//
//   fly ssh console -a bendit -C "node /srv/tools/users.mjs list"
//
// It writes straight to the database on the volume, so it works whether or not
// the app is running — SQLite in WAL mode takes a second writer happily.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  countUsers,
  createUser,
  createUsersTable,
  deleteUser,
  listUsers,
  setPassword,
} from '../lib/users.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const [command, username] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dbPath = arg('db') ?? process.env.SQLITE_PATH ?? '/data/bendit.db';

const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** Asked for rather than passed, so it stays out of the shell's history. */
function askPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo off: a password typed into a shared terminal shouldn't be readable
    // over a shoulder or scrolled back to.
    const wasRaw = process.stdin.isTTY;
    if (wasRaw) {
      rl.output.write(prompt);
      rl._writeToOutput = () => {};
    }
    rl.question(wasRaw ? '' : prompt, (answer) => {
      if (wasRaw) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

if (!fs.existsSync(dbPath) && command !== 'help') {
  die(`No database at ${dbPath}. Pass --db, or set SQLITE_PATH.`);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
createUsersTable(db);

const usage = `Usage:
  users.mjs add <username> [--password <password>]
  users.mjs list
  users.mjs passwd <username> [--password <password>]
  users.mjs remove <username>
Options:
  --db <path>   database to work on (default ${dbPath})`;

try {
  switch (command) {
    case 'add': {
      if (!username) die(usage);
      const password = arg('password') ?? (await askPassword(`Password for "${username}": `));
      const user = createUser(db, username, password);
      const total = countUsers(db);
      process.stdout.write(
        `Added "${user.username}".` +
          (total === 1 ? ' They are the first user, so they can sign in and set up their profile.\n' : '\n'),
      );
      break;
    }

    case 'list': {
      const users = listUsers(db);
      if (users.length === 0) {
        process.stdout.write('No users yet. Add one with: users.mjs add <username>\n');
        break;
      }
      for (const user of users) {
        // What each account actually holds, so an empty one is recognisable.
        const counts = ['food_log', 'weights', 'photos']
          .map((table) => {
            const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE userId = ?`).get(user.id).n;
            return `${n} ${table.replace('food_log', 'entries').replace('_', ' ')}`;
          })
          .join(', ');
        process.stdout.write(`${user.username.padEnd(20)} since ${user.createdAt.slice(0, 10)}  ${counts}\n`);
      }
      break;
    }

    case 'passwd': {
      if (!username) die(usage);
      const password = arg('password') ?? (await askPassword(`New password for "${username}": `));
      setPassword(db, username, password);
      process.stdout.write(`Changed the password for "${username}". Their other devices are signed out.\n`);
      break;
    }

    case 'remove': {
      if (!username) die(usage);
      const removed = deleteUser(db, username);
      const summary = Object.entries(removed)
        .filter(([, n]) => n > 0)
        .map(([table, n]) => `${n} ${table}`)
        .join(', ');
      process.stdout.write(`Removed "${username}"${summary ? `, along with ${summary}` : ''}.\n`);
      break;
    }

    default:
      process.stdout.write(`${usage}\n`);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  die(error.message);
} finally {
  db.close();
}
