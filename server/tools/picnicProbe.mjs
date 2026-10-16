#!/usr/bin/env node
// Signs into Picnic and saves what a few products' details look like, so the
// nutrition parser is written against real responses rather than guesses.
//
//   node server/tools/picnicProbe.mjs                 # signs in; sends an SMS code if Picnic asks
//   node server/tools/picnicProbe.mjs --code 123456   # finishes signing in with that code
//   node server/tools/picnicProbe.mjs --search "halfvolle melk"
//
// Reads PICNIC_USERNAME, PICNIC_PASSWORD and PICNIC_COUNTRY_CODE (default NL).
// The session is kept in .picnic-session.json in the current directory, so the
// code is only needed once. Product details are written to picnic-probe.json.

import fs from 'node:fs';
import PicnicClient from 'picnic-api';

const SESSION = '.picnic-session.json';
const OUTPUT = 'picnic-probe.json';

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const countryCode = process.env.PICNIC_COUNTRY_CODE ?? 'NL';
const saved = fs.existsSync(SESSION) ? JSON.parse(fs.readFileSync(SESSION, 'utf8')) : null;
const save = (session) => fs.writeFileSync(SESSION, JSON.stringify(session), { mode: 0o600 });

async function signIn() {
  const code = arg('code');
  if (code) {
    if (!saved?.pendingAuthKey) throw new Error('No sign-in is waiting for a code. Run without --code first.');
    const client = new PicnicClient({ countryCode, authKey: saved.pendingAuthKey });
    const { authKey } = await client.auth.verify2FACode(code);
    save({ authKey });
    console.log('Signed in.');
    return new PicnicClient({ countryCode, authKey });
  }
  if (saved?.authKey) return new PicnicClient({ countryCode, authKey: saved.authKey });

  const { PICNIC_USERNAME: username, PICNIC_PASSWORD: password } = process.env;
  if (!username || !password) throw new Error('Set PICNIC_USERNAME and PICNIC_PASSWORD.');
  const client = new PicnicClient({ countryCode });
  const login = await client.auth.login(username, password);
  if (login.second_factor_authentication_required) {
    await client.auth.generate2FACode('SMS');
    save({ pendingAuthKey: login.authKey });
    console.log('Picnic sent an SMS code. Run again with --code <code>.');
    return null;
  }
  save({ authKey: login.authKey });
  console.log('Signed in.');
  return client;
}

const client = await signIn();
if (client) {
  const queries = arg('search') ? [arg('search')] : ['halfvolle melk', 'kipfilet', 'volkoren brood', 'appel'];
  const results = [];
  for (const query of queries) {
    const found = await client.catalog.search(query);
    for (const unit of found.slice(0, 2)) {
      const details = await client.catalog.getProductDetails(unit.id);
      results.push({ query, searchResult: unit, details });
      const nutrition = details.infoSections.find((s) => /voeding|nutri|nährwert/i.test(s.title));
      console.log(`\n${details.name} (${details.unitQuantity})\n${nutrition?.content ?? '(no nutrition section)'}`);
    }
  }
  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${results.length} products to ${OUTPUT}`);
}
