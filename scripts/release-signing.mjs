import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RELEASE_SIGNATURE_SCHEMA = "suzu-lives-release-signature/v1";
export const RELEASE_SIGNING_KEY_ID = "eryuchengye";
export const RELEASE_SIGNING_ALGORITHM = "Ed25519";
export const releasePublicKeyPath = path.join(repositoryRoot, "release-keys", `${RELEASE_SIGNING_KEY_ID}.ed25519.pub`);
export const defaultReleasePrivateKeyPath = path.join(
  os.homedir(),
  ".suzu-lives",
  "release-signing",
  `${RELEASE_SIGNING_KEY_ID}.ed25519.private.pem`,
);

function cleanPath(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("缺少文件路径。");
  return path.resolve(process.cwd(), text);
}

function isInsideDirectory(targetPath, directoryPath) {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertPrivateKeyOutsideRepository(privateKeyPath) {
  if (isInsideDirectory(privateKeyPath, repositoryRoot)) {
    throw new Error("发布私钥不能保存在仓库中。请使用仓库外的受保护路径。");
  }
}

function requireOption(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`缺少 ${name} 参数。`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个文件路径。`);
  return value;
}

function createSignaturePayload({ artifact, sha256, publicKeyFingerprint }) {
  return [
    `schema=${RELEASE_SIGNATURE_SCHEMA}`,
    `keyId=${RELEASE_SIGNING_KEY_ID}`,
    `algorithm=${RELEASE_SIGNING_ALGORITHM}`,
    `artifact=${artifact}`,
    `sha256=${sha256}`,
    `publicKeyFingerprint=${publicKeyFingerprint}`,
    "",
  ].join("\n");
}

function parseSignatureEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("签名文件不是有效 JSON。");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("签名文件格式无效。");
  }
  return envelope;
}

function validateSignatureEnvelope(envelope, artifactName, sha256, publicKeyFingerprint) {
  const expected = {
    schema: RELEASE_SIGNATURE_SCHEMA,
    keyId: RELEASE_SIGNING_KEY_ID,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    artifact: artifactName,
    sha256,
    publicKeyFingerprint,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (envelope[field] !== value) {
      throw new Error(`签名文件的 ${field} 与当前发布包不匹配。`);
    }
  }
  if (typeof envelope.signature !== "string" || !envelope.signature) {
    throw new Error("签名文件缺少签名内容。");
  }
  const signature = Buffer.from(envelope.signature, "base64");
  if (!signature.length || signature.toString("base64") !== envelope.signature) {
    throw new Error("签名文件中的 Base64 签名无效。");
  }
  return signature;
}

async function hashFile(filePath) {
  await fs.access(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function readPublicKey(publicKeyPath) {
  const source = await fs.readFile(publicKeyPath, "utf8");
  return createPublicKey(source);
}

export function publicKeyFingerprint(publicKey) {
  const key = typeof publicKey === "string" || Buffer.isBuffer(publicKey)
    ? createPublicKey(publicKey)
    : publicKey;
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export async function generateReleaseSigningKeyPair({
  privateKeyPath = defaultReleasePrivateKeyPath,
  publicKeyPath = releasePublicKeyPath,
  force = false,
} = {}) {
  const resolvedPrivateKeyPath = path.resolve(privateKeyPath);
  const resolvedPublicKeyPath = path.resolve(publicKeyPath);
  assertPrivateKeyOutsideRepository(resolvedPrivateKeyPath);

  if (!force) {
    const existing = await Promise.all([resolvedPrivateKeyPath, resolvedPublicKeyPath].map(async (candidate) => {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        return "";
      }
    }));
    const occupiedPath = existing.find(Boolean);
    if (occupiedPath) throw new Error(`拒绝覆盖已有密钥文件：${occupiedPath}`);
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await Promise.all([
    fs.mkdir(path.dirname(resolvedPrivateKeyPath), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(resolvedPublicKeyPath), { recursive: true }),
  ]);
  await fs.writeFile(resolvedPrivateKeyPath, privateKey, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(resolvedPublicKeyPath, publicKey, { encoding: "utf8" });

  return {
    privateKeyPath: resolvedPrivateKeyPath,
    publicKeyPath: resolvedPublicKeyPath,
    fingerprint: publicKeyFingerprint(publicKey),
  };
}

export async function signReleaseArtifact({
  artifactPath,
  privateKeyPath = defaultReleasePrivateKeyPath,
  publicKeyPath = releasePublicKeyPath,
  signaturePath = `${artifactPath}.sig`,
} = {}) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const resolvedPrivateKeyPath = path.resolve(privateKeyPath);
  const resolvedPublicKeyPath = path.resolve(publicKeyPath);
  const resolvedSignaturePath = path.resolve(signaturePath);
  assertPrivateKeyOutsideRepository(resolvedPrivateKeyPath);

  const [sha256, privateSource, publicKey] = await Promise.all([
    hashFile(resolvedArtifactPath),
    fs.readFile(resolvedPrivateKeyPath, "utf8"),
    readPublicKey(resolvedPublicKeyPath),
  ]);
  const fingerprint = publicKeyFingerprint(publicKey);
  const artifact = path.basename(resolvedArtifactPath);
  const payload = createSignaturePayload({ artifact, sha256, publicKeyFingerprint: fingerprint });
  const signature = sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateSource));
  if (!verify(null, Buffer.from(payload, "utf8"), publicKey, signature)) {
    throw new Error("发布私钥与仓库中的官方公钥不匹配，已拒绝签名。");
  }
  const envelope = {
    schema: RELEASE_SIGNATURE_SCHEMA,
    keyId: RELEASE_SIGNING_KEY_ID,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    artifact,
    sha256,
    publicKeyFingerprint: fingerprint,
    signature: signature.toString("base64"),
  };
  await fs.writeFile(resolvedSignaturePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return { ...envelope, signaturePath: resolvedSignaturePath };
}

export async function verifyReleaseArtifact({
  artifactPath,
  signaturePath = `${artifactPath}.sig`,
  publicKeyPath = releasePublicKeyPath,
} = {}) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const resolvedSignaturePath = path.resolve(signaturePath);
  const resolvedPublicKeyPath = path.resolve(publicKeyPath);
  const [sha256, signatureSource, publicKey] = await Promise.all([
    hashFile(resolvedArtifactPath),
    fs.readFile(resolvedSignaturePath, "utf8"),
    readPublicKey(resolvedPublicKeyPath),
  ]);
  const fingerprint = publicKeyFingerprint(publicKey);
  const artifact = path.basename(resolvedArtifactPath);
  const envelope = parseSignatureEnvelope(signatureSource);
  const signature = validateSignatureEnvelope(envelope, artifact, sha256, fingerprint);
  const payload = createSignaturePayload({ artifact, sha256, publicKeyFingerprint: fingerprint });
  const valid = verify(null, Buffer.from(payload, "utf8"), publicKey, signature);
  if (!valid) throw new Error("签名校验失败：该发布包不是由官方私钥签发，或文件已被篡改。");
  return { valid, sha256, publicKeyFingerprint: fingerprint };
}

function printUsage() {
  console.log(`用法：
  node scripts/release-signing.mjs generate-key
  node scripts/release-signing.mjs sign --artifact <发布包路径> [--signature <签名路径>] [--private-key <私钥路径>]
  node scripts/release-signing.mjs verify --artifact <发布包路径> [--signature <签名路径>]`);
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "generate-key") {
    const generated = await generateReleaseSigningKeyPair({ force: args.includes("--force") });
    console.log(`已生成 Ed25519 发布密钥。\n私钥（不要提交、不要外传）：${generated.privateKeyPath}\n公钥：${generated.publicKeyPath}\n公钥指纹（SHA-256）：${generated.fingerprint}`);
    return;
  }
  if (command === "sign") {
    const artifactPath = cleanPath(requireOption(args, "--artifact"));
    const signatureOption = optionalOption(args, "--signature");
    const privateOption = optionalOption(args, "--private-key");
    const signed = await signReleaseArtifact({
      artifactPath,
      signaturePath: signatureOption ? cleanPath(signatureOption) : `${artifactPath}.sig`,
      privateKeyPath: privateOption
        ? cleanPath(privateOption)
        : (process.env.SUZU_RELEASE_SIGNING_KEY ? cleanPath(process.env.SUZU_RELEASE_SIGNING_KEY) : defaultReleasePrivateKeyPath),
    });
    console.log(`签名完成：${signed.signaturePath}\nSHA-256：${signed.sha256}\n公钥指纹：${signed.publicKeyFingerprint}`);
    return;
  }
  if (command === "verify") {
    const artifactPath = cleanPath(requireOption(args, "--artifact"));
    const signatureOption = optionalOption(args, "--signature");
    const checked = await verifyReleaseArtifact({
      artifactPath,
      signaturePath: signatureOption ? cleanPath(signatureOption) : `${artifactPath}.sig`,
    });
    console.log(`签名有效。\nSHA-256：${checked.sha256}\n公钥指纹：${checked.publicKeyFingerprint}`);
    return;
  }
  throw new Error(`未知命令：${command}`);
}

const executedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedDirectly) {
  runCli().catch((error) => {
    console.error(`发布签名失败：${error?.message || error}`);
    process.exitCode = 1;
  });
}
