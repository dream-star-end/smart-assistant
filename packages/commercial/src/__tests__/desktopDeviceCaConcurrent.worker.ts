import { certFingerprintSha256Bytes, ensureDesktopOriginCert } from "../desktop/deviceCa.js";

const origin = await ensureDesktopOriginCert();
const fp = await certFingerprintSha256Bytes(origin.certPem);
process.stdout.write(fp.toString("hex"));
