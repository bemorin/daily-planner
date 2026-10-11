// Generate the Daily Planner Plus key pair, or show the public key of an
// existing one.
//
//   node scripts/plus-keys.mjs            new PLUS_SIGNING_KEY + DAILY_PLANNER_PLUS_PUBLIC_KEY
//   node scripts/plus-keys.mjs --public   the public key matching $PLUS_SIGNING_KEY
//
// No dependencies: WebCrypto through server/licenses.js (the code the API
// itself signs licences with). The private key is read from the environment,
// never from the command line, so it stays out of your shell history.

import { generatePlusKeyPair, publicKeyFromSigningKey, signLicense, verifyLicense } from '../server/licenses.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/plus-keys.mjs [--public]   (--public reads PLUS_SIGNING_KEY from the environment)');
  process.exit(0);
}

if (args.includes('--public')) {
  const secret = process.env.PLUS_SIGNING_KEY || '';
  if (!secret.trim()) {
    console.error('Set PLUS_SIGNING_KEY in the environment first, e.g.  PLUS_SIGNING_KEY=... node scripts/plus-keys.mjs --public');
    process.exit(1);
  }
  const publicKey = await publicKeyFromSigningKey(secret);
  if (!publicKey) {
    console.error('PLUS_SIGNING_KEY is not a base64 PKCS#8 ECDSA P-256 private key.');
    process.exit(1);
  }
  console.log(`DAILY_PLANNER_PLUS_PUBLIC_KEY=${publicKey}`);
  process.exit(0);
}

const { signingKey, publicKey } = await generatePlusKeyPair();
// Prove the pair works the way the app checks it before printing it.
const sample = await signLicense(signingKey, { src: 'dev' });
if (!await verifyLicense(publicKey, sample)) {
  console.error('The new key pair did not verify. Nothing to save; please run the script again.');
  process.exit(1);
}

console.log(`
Daily Planner Plus: new licence keys
====================================

PLUS_SIGNING_KEY=${signingKey}

DAILY_PLANNER_PLUS_PUBLIC_KEY=${publicKey}

1. Save PLUS_SIGNING_KEY in your password manager now. It is not stored
   anywhere else. Anyone who has it can make Plus licences.
2. Cloudflare Pages → your project → Settings → Variables and secrets:
   - add PLUS_SIGNING_KEY as an encrypted secret (Production);
   - add DAILY_PLANNER_PLUS_PUBLIC_KEY as a plain variable (it is public:
     the build puts it in runtime-config.js so the app can check licences).
   Then redeploy, so the Function and the app both use the new pair.
3. Open /admin/ → Setup: "Plus keys" shows the public key the server
   derives from PLUS_SIGNING_KEY and whether the app build matches it.

Changing the keys later makes every existing licence and gift manage link
invalid, so keep this pair for the life of the product.

Show the public key again:  PLUS_SIGNING_KEY=... node scripts/plus-keys.mjs --public
Try it locally:             PLUS_SIGNING_KEY=... npm run start:api
`);
