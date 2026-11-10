// Run before `pnpm start` in the e2e web server command: writes the mail sink's key and certificate, which the server
// trusts through NODE_EXTRA_CA_CERTS (playwright.config.ts). Test-only; nothing in src/ reads these files.
import { mkdirSync, writeFileSync } from "node:fs";
import { localhostCertificate } from "../helpers/tls";

async function main() {
  const { key, cert } = await localhostCertificate();
  mkdirSync(".e2e", { recursive: true });
  writeFileSync(".e2e/sink-key.pem", key);
  writeFileSync(".e2e/sink-cert.pem", cert);
}

main().catch((e) => { console.error(e); process.exit(1); });
