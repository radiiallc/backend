import { Resend } from "resend";

import { env } from "../../env";

const resend = new Resend(env.resendApiKey);

const FROM_ADDRESS = env.resendFromEmail;

type SendArgs = { to: string | string[]; subject: string; text: string; html?: string };

export class EmailSendError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "EmailSendError";
  }
}

async function sendPlainText({ to, subject, text, html }: SendArgs): Promise<void> {
  let result: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    result = await resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject,
      text,
      ...(html ? { html } : {})
    });
  } catch (err) {
    console.error("[email] threw", { to, from: FROM_ADDRESS, subject, err });
    const message = err instanceof Error ? err.message : "Email provider threw an unknown error";
    throw new EmailSendError(message, err);
  }

  if (result.error) {
    console.error("[email] send failed", {
      to,
      from: FROM_ADDRESS,
      subject,
      error: result.error
    });
    const name = (result.error as { name?: string }).name ?? "EmailError";
    const message = result.error.message ?? "Unknown email provider error";
    throw new EmailSendError(`${name}: ${message}`, result.error);
  }
}

export async function sendSignupAdminNotification(args: {
  applicantEmail: string;
  applicantName: string;
  companyName: string;
}): Promise<void> {
  await sendPlainText({
    to: env.notificationEmail,
    subject: `New signup pending review: ${args.applicantName}`,
    text:
      `A new account is awaiting approval on the RADIIA portal.\n\n` +
      `Name: ${args.applicantName}\n` +
      `Email: ${args.applicantEmail}\n` +
      `Company: ${args.companyName}\n\n` +
      `Review at ${env.appUrl}/admin/accounts.`
  });
}

export async function sendSignupApplicantConfirmation(args: {
  email: string;
  firstName: string;
}): Promise<void> {
  const text =
    `Hi ${args.firstName},\n\n` +
    `Thanks for signing up for the RADIIA inventory portal. Your account is pending admin ` +
    `review, and we'll email you again once you're approved. Please get in touch at ` +
    `production@radiia.co with any questions in the meantime.\n\n` +
    `RADIIA\nwww.radiia.co`;
  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 560px;">` +
    `<p style="margin: 0 0 16px;">Hi ${escapeHtml(args.firstName)},</p>` +
    `<p style="margin: 0 0 16px;">Thanks for signing up for the RADIIA inventory portal. ` +
    `Your account is pending admin review, and we'll email you again once you're approved. ` +
    `Please get in touch at <a href="mailto:production@radiia.co" style="color: #111;">production@radiia.co</a> ` +
    `with any questions in the meantime.</p>` +
    `<p style="margin: 32px 0 4px;">RADIIA</p>` +
    `<p style="margin: 0 0 16px;"><a href="https://www.radiia.co" style="color: #111;">www.radiia.co</a></p>` +
    logoImgTag() +
    `</div>`;
  await sendPlainText({
    to: args.email,
    subject: "RADIIA inventory portal sign-up",
    text,
    html
  });
}

function logoImgTag(): string {
  if (!env.publicAppUrl) return "";
  const logoUrl = `${env.appUrl}/email/radiia-logo.png`;
  return `<img src="${logoUrl}" alt="RADIIA" width="120" style="display: block; margin-top: 8px;" />`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendPasswordResetEmail(args: {
  email: string;
  firstName: string;
  resetUrl: string;
}): Promise<void> {
  const text =
    `Hi ${args.firstName},\n\n` +
    `We received a request to reset your password.\n\n` +
    `Open this link within 30 minutes to set a new password:\n\n` +
    `${args.resetUrl}\n\n` +
    `If you didn't request this, you can safely ignore this email.\n\n` +
    `RADIIA\nwww.radiia.co`;
  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 560px;">` +
    `<p style="margin: 0 0 16px;">Hi ${escapeHtml(args.firstName)},</p>` +
    `<p style="margin: 0 0 16px;">We received a request to reset your password.</p>` +
    `<p style="margin: 0 0 16px;">Open this link within 30 minutes to set a new password:</p>` +
    `<p style="margin: 0 0 16px;"><a href="${args.resetUrl}" style="color: #111;">${args.resetUrl}</a></p>` +
    `<p style="margin: 0 0 16px;">If you didn't request this, you can safely ignore this email.</p>` +
    `<p style="margin: 32px 0 4px;">RADIIA</p>` +
    `<p style="margin: 0 0 16px;"><a href="https://www.radiia.co" style="color: #111;">www.radiia.co</a></p>` +
    logoImgTag() +
    `</div>`;
  await sendPlainText({
    to: args.email,
    subject: "Reset your RADIIA portal password",
    text,
    html
  });
}

export async function sendAccountApprovalEmail(args: {
  email: string;
  firstName: string;
}): Promise<void> {
  const loginUrl = `${env.appUrl}/auth/login`;
  const text =
    `Hi ${args.firstName},\n\n` +
    `We have approved your account to access our stone inventory! You can log in with ` +
    `your email address and password at the link below:\n\n` +
    `${loginUrl}\n\n` +
    `We look forward to working with you. If you have any questions, don't hesitate to ` +
    `reach out to us at production@radiia.co.\n\n` +
    `RADIIA\nwww.radiia.co`;
  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 560px;">` +
    `<p style="margin: 0 0 16px;">Hi ${escapeHtml(args.firstName)},</p>` +
    `<p style="margin: 0 0 16px;">We have approved your account to access our stone inventory! ` +
    `You can log in with your email address and password at the link below:</p>` +
    `<p style="margin: 0 0 16px;"><a href="${loginUrl}" style="color: #111;">${loginUrl}</a></p>` +
    `<p style="margin: 0 0 16px;">We look forward to working with you. If you have any questions, ` +
    `don't hesitate to reach out to us at ` +
    `<a href="mailto:production@radiia.co" style="color: #111;">production@radiia.co</a>.</p>` +
    `<p style="margin: 32px 0 4px;">RADIIA</p>` +
    `<p style="margin: 0 0 16px;"><a href="https://www.radiia.co" style="color: #111;">www.radiia.co</a></p>` +
    logoImgTag() +
    `</div>`;
  await sendPlainText({
    to: args.email,
    subject: "RADIIA inventory portal access",
    text,
    html
  });
}

export async function sendAccountDeclineEmail(args: {
  email: string;
  fullName: string;
  reason?: string | null;
}): Promise<void> {
  const reasonLine = args.reason && args.reason.trim().length > 0
    ? `\n\nNote from the team:\n${args.reason.trim()}\n`
    : "\n\n";
  await sendPlainText({
    to: args.email,
    subject: "Update on your RADIIA portal application",
    text:
      `Hi ${args.fullName},\n\n` +
      `Thank you for your interest in the RADIIA portal. After review, we are unable to ` +
      `approve your account at this time.${reasonLine}` +
      `If you have questions, reply to this email.\n\n— RADIIA`
  });
}

export type IngestAlertFile = {
  name: string;
  rowsParsed: number;
  rowsUpserted: number;
};

export async function sendIngestFailureAlert(args: {
  reason: string;
  status: string;
  source?: string | null;
  durationMs: number;
  rowsUpsertedTotal: number;
  files: IngestAlertFile[];
  skippedFiles: { name: string; reason: string }[];
  errorText?: string | null;
  repeated: boolean;
  consecutiveFailures?: number;
}): Promise<void> {
  const fileLines =
    args.files.length > 0
      ? args.files
          .map((f) => `  - ${f.name}: ${f.rowsParsed} parsed, ${f.rowsUpserted} upserted`)
          .join("\n")
      : "  (none)";
  const skippedLines =
    args.skippedFiles.length > 0
      ? "\nSkipped files:\n" +
        args.skippedFiles.map((s) => `  - ${s.name}: ${s.reason}`).join("\n") +
        "\n"
      : "";
  const errorBlock = args.errorText ? `\nError:\n${args.errorText}\n` : "";
  const prefix = args.repeated ? "[STILL FAILING] " : "";
  const streakLine =
    args.consecutiveFailures && args.consecutiveFailures > 1
      ? `Consecutive failed runs: ${args.consecutiveFailures}\n`
      : "";

  await sendPlainText({
    to: env.notificationEmail,
    subject: `${prefix}RADIIA ingest alert: ${args.reason.split(":")[0]}`,
    text:
      `The RADIIA inventory ingest needs attention.\n\n` +
      `${args.reason}\n\n` +
      `Status: ${args.status}\n` +
      `Source: ${args.source ?? "n/a"}\n` +
      `Duration: ${(args.durationMs / 1000).toFixed(1)}s\n` +
      `Rows upserted: ${args.rowsUpsertedTotal}\n` +
      streakLine +
      `\n` +
      `Files:\n${fileLines}\n` +
      skippedLines +
      errorBlock +
      `\nReview ingest history and the feed source, then re-run the cron if needed.\n\n` +
      `RADIIA portal`
  });
}

export async function sendIngestRecoveryAlert(args: {
  rowsUpsertedTotal: number;
  source?: string | null;
}): Promise<void> {
  await sendPlainText({
    to: env.notificationEmail,
    subject: "RADIIA ingest recovered",
    text:
      `The RADIIA inventory ingest is healthy again.\n\n` +
      `The most recent run completed successfully` +
      `${args.source ? ` (source: ${args.source})` : ""} ` +
      `with ${args.rowsUpsertedTotal} row(s) upserted.\n\n` +
      `RADIIA portal`
  });
}

export type AccountSettingsChanges = {
  creditLimitUsd?: number;
  labDiamondMarkupPct?: number;
  naturalDiamondMarkupPct?: number;
  gemstoneMarkupPct?: number;
};

function formatUsdAmount(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatPct(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

export async function sendAccountSettingsChangeEmail(args: {
  companyName: string;
  changes: AccountSettingsChanges;
}): Promise<void> {
  const lines: string[] = [];
  if (args.changes.creditLimitUsd !== undefined) {
    lines.push(`New credit limit: ${formatUsdAmount(args.changes.creditLimitUsd)}`);
  }
  if (args.changes.labDiamondMarkupPct !== undefined) {
    lines.push(`New lab diamond markup: ${formatPct(args.changes.labDiamondMarkupPct)}`);
  }
  if (args.changes.naturalDiamondMarkupPct !== undefined) {
    lines.push(`New natural diamond markup: ${formatPct(args.changes.naturalDiamondMarkupPct)}`);
  }
  if (args.changes.gemstoneMarkupPct !== undefined) {
    lines.push(`New gemstones markup: ${formatPct(args.changes.gemstoneMarkupPct)}`);
  }
  if (lines.length === 0) return;

  await sendPlainText({
    to: env.inventoryEmail,
    subject: `RADIIA account settings changed: ${args.companyName}`,
    text:
      `Please note that ${args.companyName}'s settings have changed.\n\n` +
      lines.join("\n") +
      `\n`
  });
}

export type RequestReviewItem = {
  sku: string;
  varietyOrName: string;
  shape?: string | null;
  weightCt?: number | null;
  outcome: "APPROVED" | "REJECTED";
  totalPriceUsd: number;
};

function formatReviewItemParts(item: RequestReviewItem): string[] {
  return [
    item.sku,
    item.varietyOrName,
    item.shape ?? null,
    item.weightCt ? `${item.weightCt}ct` : null,
    formatUsd(item.totalPriceUsd)
  ].filter((p): p is string => Boolean(p));
}

export async function sendRequestReviewSummaryEmail(args: {
  email: string;
  firstName: string;
  reference: string;
  type: "MEMO" | "INVOICE";
  overallStatus: "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED";
  items: RequestReviewItem[];
  externalNote?: string | null;
}): Promise<void> {
  const subjectTypeWord = args.type === "MEMO" ? "Memo" : "Invoice";
  const approved = args.items.filter((i) => i.outcome === "APPROVED");
  const rejected = args.items.filter((i) => i.outcome === "REJECTED");
  const trimmedNote = args.externalNote?.trim();

  const approvedTextLines = approved
    .map((item) => `  - ${formatReviewItemParts(item).join(" · ")}`)
    .join("\n");
  const rejectedTextBlock =
    rejected.length > 0
      ? `\nUnfortunately, the item(s) below are no longer available:\n\n` +
        rejected
          .map((item) => `  - ${formatReviewItemParts(item).join(" · ")}`)
          .join("\n") +
        `\n\n`
      : "";
  const noteTextBlock = trimmedNote ? `${trimmedNote}\n\n` : "";

  const text =
    `Hi ${args.firstName},\n\n` +
    (approved.length > 0
      ? `The item(s) below from Request #${args.reference} have been approved:\n\n${approvedTextLines}\n\n`
      : `None of the items in Request #${args.reference} were approved.\n\n`) +
    rejectedTextBlock +
    noteTextBlock +
    `Please contact us at production@radiia.co if you have any further questions.\n\n` +
    `Warmly,\n\n` +
    `RADIIA\nwww.radiia.co`;

  const renderItemList = (items: RequestReviewItem[]) =>
    `<ul style="margin: 0 0 16px; padding-left: 20px;">` +
    items
      .map(
        (item) =>
          `<li style="margin: 0 0 6px;">` +
          formatReviewItemParts(item).map(escapeHtml).join(" &middot; ") +
          `</li>`
      )
      .join("") +
    `</ul>`;

  const approvedHtmlSection =
    approved.length > 0
      ? `<p style="margin: 0 0 8px;">The item(s) below from Request #${escapeHtml(args.reference)} have been approved:</p>` +
        renderItemList(approved)
      : `<p style="margin: 0 0 16px;">None of the items in Request #${escapeHtml(args.reference)} were approved.</p>`;
  const rejectedHtmlSection =
    rejected.length > 0
      ? `<p style="margin: 0 0 8px;">Unfortunately, the item(s) below are no longer available:</p>` +
        renderItemList(rejected)
      : "";
  const noteHtmlBlock = trimmedNote
    ? `<p style="margin: 0 0 16px; white-space: pre-wrap;">${escapeHtml(trimmedNote)}</p>`
    : "";

  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 560px;">` +
    `<p style="margin: 0 0 16px;">Hi ${escapeHtml(args.firstName)},</p>` +
    approvedHtmlSection +
    rejectedHtmlSection +
    noteHtmlBlock +
    `<p style="margin: 0 0 16px;">Please contact us at ` +
    `<a href="mailto:production@radiia.co" style="color: #111;">production@radiia.co</a> ` +
    `if you have any further questions.</p>` +
    `<p style="margin: 0 0 16px;">Warmly,</p>` +
    `<p style="margin: 0 0 4px;">RADIIA</p>` +
    `<p style="margin: 0 0 16px;"><a href="https://www.radiia.co" style="color: #111;">www.radiia.co</a></p>` +
    logoImgTag() +
    `</div>`;

  await sendPlainText({
    to: args.email,
    subject: `RADIIA ${subjectTypeWord} request #${args.reference} has been reviewed`,
    text,
    html
  });
}

export type SubmittedRequestItem = {
  sku: string;
  varietyOrName: string;
  stoneType: string;
  color?: string | null;
  clarity?: string | null;
  shape?: string | null;
  weightCt?: number | null;
  totalPriceUsd: number;
};

export async function sendRequestSubmittedConfirmation(args: {
  email: string;
  firstName: string;
  reference: string;
  requestId: string;
  type: "MEMO" | "INVOICE";
  items: SubmittedRequestItem[];
  totalUsd: number;
  note?: string | null;
}): Promise<void> {
  const subjectTypeWord = args.type === "MEMO" ? "Memo" : "Invoice";
  const portalUrl = env.appUrl;
  const requestUrl = `${env.appUrl}/requests/${args.requestId}`;
  const trimmedNote = args.note?.trim();

  const textLines = args.items
    .map((item) => {
      const parts = [
        item.sku,
        item.varietyOrName,
        item.shape ?? null,
        item.weightCt ? `${item.weightCt}ct` : null,
        formatUsd(item.totalPriceUsd)
      ].filter((p): p is string => Boolean(p));
      return `  - ${parts.join(" · ")}`;
    })
    .join("\n");
  const noteTextBlock = trimmedNote ? `Your note:\n\n${trimmedNote}\n\n` : "";
  const text =
    `Hi ${args.firstName},\n\n` +
    `We have received your request for the below item(s). Our team will review and ` +
    `confirm availability as soon as possible!\n\n` +
    `Items:\n${textLines}\n\n` +
    `Total: ${formatUsd(args.totalUsd)}\n\n` +
    noteTextBlock +
    `${portalUrl}\n\n` +
    `You can also view the status of your request here: ${requestUrl}\n\n` +
    `RADIIA\nwww.radiia.co`;

  const htmlItemRows = args.items
    .map((item) => {
      const parts = [
        item.sku,
        item.varietyOrName,
        item.shape ?? null,
        item.weightCt ? `${item.weightCt}ct` : null,
        formatUsd(item.totalPriceUsd)
      ]
        .filter((p): p is string => Boolean(p))
        .map(escapeHtml)
        .join(" &middot; ");
      return `<li style="margin: 0 0 6px;">${parts}</li>`;
    })
    .join("");
  const noteHtmlBlock = trimmedNote
    ? `<p style="margin: 0 0 8px;">Your note:</p>` +
      `<p style="margin: 0 0 24px; white-space: pre-wrap;">${escapeHtml(trimmedNote)}</p>`
    : "";
  const html =
    `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; line-height: 1.6; max-width: 560px;">` +
    `<p style="margin: 0 0 16px;">Hi ${escapeHtml(args.firstName)},</p>` +
    `<p style="margin: 0 0 16px;">We have received your request for the below item(s). ` +
    `Our team will review and confirm availability as soon as possible!</p>` +
    `<p style="margin: 0 0 8px;">Items:</p>` +
    `<ul style="margin: 0 0 16px; padding-left: 20px;">${htmlItemRows}</ul>` +
    `<p style="margin: 0 0 24px;"><strong>Total:</strong> ${escapeHtml(formatUsd(args.totalUsd))}</p>` +
    noteHtmlBlock +
    `<p style="margin: 0 0 16px;"><a href="${portalUrl}" style="color: #111;">${portalUrl}</a></p>` +
    `<p style="margin: 0 0 16px;">You can also view the status of your request here: ` +
    `<a href="${requestUrl}" style="color: #111;">${requestUrl}</a></p>` +
    `<p style="margin: 32px 0 4px;">RADIIA</p>` +
    `<p style="margin: 0 0 16px;"><a href="https://www.radiia.co" style="color: #111;">www.radiia.co</a></p>` +
    logoImgTag() +
    `</div>`;

  await sendPlainText({
    to: args.email,
    subject: `RADIIA ${subjectTypeWord} request #${args.reference} received`,
    text,
    html
  });
}

function formatSubmittedItemLine(item: SubmittedRequestItem): string {
  const details = [
    item.stoneType,
    item.weightCt ? `${item.weightCt}ct` : null,
    item.color ?? null,
    item.clarity ?? null,
    item.shape ?? null,
    formatUsd(item.totalPriceUsd)
  ].filter((p): p is string => Boolean(p));
  return ` - ${item.sku} · ${details.join(" ")}`;
}

export async function sendRequestSubmittedAdminNotification(args: {
  buyerEmail: string;
  buyerName: string;
  companyName: string;
  reference: string;
  type: "MEMO" | "INVOICE";
  items: SubmittedRequestItem[];
  totalUsd: number;
  note?: string | null;
}): Promise<void> {
  const typeWord = args.type === "MEMO" ? "memo" : "invoice";
  const itemLines = args.items.map(formatSubmittedItemLine).join("\n");
  const trimmedNote = args.note?.trim();
  const noteBlock = trimmedNote ? `Note from the client:\n${trimmedNote}\n\n` : "";
  const recipients = Array.from(
    new Set([env.notificationEmail, env.inventoryEmail].filter(Boolean))
  );
  await sendPlainText({
    to: recipients,
    subject: `New ${typeWord} request ${args.reference} from ${args.buyerName}`,
    text:
      `A new ${typeWord} request is awaiting review on the RADIIA portal.\n\n` +
      `Reference: ${args.reference}\n` +
      `Buyer: ${args.buyerName} <${args.buyerEmail}>\n` +
      `Company: ${args.companyName}\n` +
      `Total: ${formatUsd(args.totalUsd)}\n\n` +
      noteBlock +
      `Items:\n${itemLines}\n\n` +
      `Review at ${env.appUrl}/admin/requests.`
  });
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
