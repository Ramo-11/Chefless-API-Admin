import crypto from "crypto";
import ClientError, {
  ClientErrorPlatform,
  ClientErrorSource,
  IClientError,
} from "../models/ClientError";
import User from "../models/User";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { escapeHtml, sendEmail } from "../lib/email";

export interface RecordClientErrorInput {
  platform: ClientErrorPlatform;
  source?: ClientErrorSource;
  exception: string;
  reason?: string;
  stack?: string;
  route?: string;
  appVersion?: string;
  buildMode?: string;
  osVersion?: string;
  deviceModel?: string;
  firebaseUid?: string;
}

export interface RecordClientErrorResult {
  errorId: string;
  isNew: boolean;
  occurrences: number;
}

function buildFingerprint(input: RecordClientErrorInput): string {
  // Collapse near-identical crashes onto one row. Same platform + build +
  // source + leading exception lines = same underlying defect.
  const firstLines = (input.exception ?? "")
    .split("\n")
    .slice(0, 2)
    .join("\n")
    .slice(0, 500);
  const seed = [
    input.platform,
    input.appVersion ?? "unknown",
    input.source ?? "other",
    firstLines.trim(),
  ].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export async function recordClientError(
  input: RecordClientErrorInput
): Promise<RecordClientErrorResult> {
  const fingerprint = buildFingerprint(input);
  const now = new Date();

  let userObjectId: IClientError["userId"];
  let userEmail: string | undefined;
  if (input.firebaseUid) {
    const user = await User.findOne({ firebaseUid: input.firebaseUid })
      .select("_id email")
      .lean();
    if (user) {
      userObjectId = user._id;
      userEmail = user.email;
    }
  }

  // Re-open resolved/ignored issues when they recur — silent regressions are
  // the worst kind, so make the re-occurrence visible in the queue.
  const existing = await ClientError.findOneAndUpdate(
    { fingerprint },
    {
      $inc: { occurrences: 1 },
      $set: {
        lastSeenAt: now,
        ...(input.stack ? { stack: input.stack } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.route ? { route: input.route } : {}),
        ...(input.osVersion ? { osVersion: input.osVersion } : {}),
        ...(input.deviceModel ? { deviceModel: input.deviceModel } : {}),
        ...(input.buildMode ? { buildMode: input.buildMode } : {}),
        ...(userObjectId ? { userId: userObjectId } : {}),
        ...(input.firebaseUid ? { firebaseUid: input.firebaseUid } : {}),
        ...(userEmail ? { userEmail } : {}),
      },
    },
    { new: false }
  );

  if (existing) {
    // Re-open if it had been marked done; the regression is the news.
    if (existing.status === "resolved" || existing.status === "ignored") {
      await ClientError.updateOne(
        { _id: existing._id },
        { $set: { status: "new" }, $unset: { resolvedAt: 1 } }
      );
    }
    return {
      errorId: existing._id.toString(),
      isNew: false,
      occurrences: existing.occurrences + 1,
    };
  }

  const created = await ClientError.create({
    fingerprint,
    platform: input.platform,
    source: input.source ?? "other",
    exception: input.exception,
    reason: input.reason,
    stack: input.stack,
    route: input.route,
    appVersion: input.appVersion,
    buildMode: input.buildMode,
    osVersion: input.osVersion,
    deviceModel: input.deviceModel,
    userId: userObjectId,
    firebaseUid: input.firebaseUid,
    userEmail,
    occurrences: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    status: "new",
  });

  // Fire-and-forget alert for fresh issues only — avoid email floods when a
  // single crash hits many users.
  void sendCrashAlert(created).catch((err) => {
    logger.error({ err, errorId: created._id.toString() }, "Crash alert failed");
  });

  return {
    errorId: created._id.toString(),
    isNew: true,
    occurrences: 1,
  };
}

async function sendCrashAlert(error: IClientError): Promise<void> {
  const subject = `[Chefless ${error.platform.toUpperCase()}] ${truncate(
    error.exception,
    120
  )}`;
  const adminUrl = `https://chefless-web.onrender.com/admin/errors/${error._id.toString()}`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.5;color:#1a1a1a;max-width:640px;">
      <h2 style="margin:0 0 8px;font-size:18px;">New Chefless crash</h2>
      <p style="margin:0 0 16px;color:#555;">A user just hit an unhandled error in the app.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr><td style="padding:6px 0;color:#888;width:140px;">Platform</td><td>${escapeHtml(error.platform)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Source</td><td>${escapeHtml(error.source)}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">App version</td><td>${escapeHtml(error.appVersion ?? "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Build</td><td>${escapeHtml(error.buildMode ?? "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Device</td><td>${escapeHtml(error.deviceModel ?? "—")} ${escapeHtml(error.osVersion ?? "")}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Route</td><td>${escapeHtml(error.route ?? "—")}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">User</td><td>${escapeHtml(error.userEmail ?? error.firebaseUid ?? "anonymous")}</td></tr>
      </table>
      <h3 style="margin:20px 0 6px;font-size:15px;">Exception</h3>
      <pre style="background:#f5f5f5;border-radius:6px;padding:12px;white-space:pre-wrap;font-size:12px;">${escapeHtml(error.exception)}</pre>
      ${error.reason ? `<h3 style="margin:16px 0 6px;font-size:15px;">Reason</h3><pre style="background:#f5f5f5;border-radius:6px;padding:12px;white-space:pre-wrap;font-size:12px;">${escapeHtml(error.reason)}</pre>` : ""}
      ${error.stack ? `<h3 style="margin:16px 0 6px;font-size:15px;">Stack</h3><pre style="background:#f5f5f5;border-radius:6px;padding:12px;white-space:pre-wrap;font-size:11px;max-height:400px;overflow:auto;">${escapeHtml(truncate(error.stack, 8000))}</pre>` : ""}
      <p style="margin-top:24px;"><a href="${adminUrl}" style="background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;">Open in admin</a></p>
    </div>
  `;

  const text = [
    `Platform: ${error.platform}`,
    `Source: ${error.source}`,
    `App version: ${error.appVersion ?? "—"}`,
    `Build: ${error.buildMode ?? "—"}`,
    `Device: ${error.deviceModel ?? "—"} ${error.osVersion ?? ""}`.trim(),
    `Route: ${error.route ?? "—"}`,
    `User: ${error.userEmail ?? error.firebaseUid ?? "anonymous"}`,
    "",
    "Exception:",
    error.exception,
    "",
    error.reason ? `Reason: ${error.reason}` : "",
    "",
    error.stack ? `Stack:\n${truncate(error.stack, 8000)}` : "",
    "",
    `Admin: ${adminUrl}`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  await sendEmail({
    to: env.ALERT_EMAIL_TO,
    subject,
    html,
    text,
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
