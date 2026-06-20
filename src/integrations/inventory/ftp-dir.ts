import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import Client from "ssh2-sftp-client";

import { env } from "../../env";

export type RemoteFile = {
  name: string;
  mtime: Date;
};

export type DownloadedFile = {
  name: string;
  mtime: Date;
  csvText: string;
};

export type DirSource = "ftp" | "fallback";

function stripBom(buf: Buffer): Buffer {
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.slice(3) : buf;
}

function ftpConfigured(): boolean {
  return Boolean(env.gemstoneFtpHost && env.gemstoneFtpUser && env.gemstoneFtpPassword);
}

async function withSftp<T>(fn: (sftp: Client) => Promise<T>): Promise<T> {
  const sftp = new Client();
  try {
    await sftp.connect({
      host: env.gemstoneFtpHost,
      port: 22,
      username: env.gemstoneFtpUser,
      password: env.gemstoneFtpPassword,
      readyTimeout: 20000
    });
    return await fn(sftp);
  } finally {
    await sftp.end().catch(() => undefined);
  }
}

export async function listIngestFiles(): Promise<{ source: DirSource; files: RemoteFile[] }> {
  if (!ftpConfigured()) {
    return { source: "fallback", files: await listLocalSampleFiles() };
  }

  return withSftp(async (sftp) => {
    const entries = await sftp.list(env.ingestFtpDir);
    const files: RemoteFile[] = entries
      .filter((e) => e.type === "-" && /\.csv$/i.test(e.name))
      .map((e) => ({
        name: e.name,
        mtime: new Date(e.modifyTime)
      }));
    return { source: "ftp" as const, files };
  });
}

export async function downloadIngestFile(name: string): Promise<DownloadedFile> {
  if (!ftpConfigured()) {
    return readLocalSample(name);
  }

  return withSftp(async (sftp) => {
    const remotePath = `${env.ingestFtpDir.replace(/\/$/, "")}/${name}`;
    const dir = remotePath.replace(/\/[^/]+$/, "") || "/";
    const entry = (await sftp.list(dir)).find((e) => e.name === name);
    const mtime = entry ? new Date(entry.modifyTime) : new Date(0);
    const buf = (await sftp.get(remotePath)) as Buffer;
    const csvText = stripBom(buf).toString("utf8");
    return { name, mtime, csvText };
  });
}

async function listLocalSampleFiles(): Promise<RemoteFile[]> {
  const dir = path.join(process.cwd(), "info");
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const matches = entries.filter((n) => /STOCK.*\.csv$/i.test(n));
  const out: RemoteFile[] = [];
  for (const name of matches) {
    const s = await stat(path.join(dir, name));
    out.push({ name, mtime: s.mtime });
  }
  return out;
}

async function readLocalSample(name: string): Promise<DownloadedFile> {
  const full = path.join(process.cwd(), "info", name);
  const buf = await readFile(full);
  const s = await stat(full);
  return {
    name,
    mtime: s.mtime,
    csvText: stripBom(buf).toString("utf8")
  };
}
