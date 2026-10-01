import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { McpToolDefinition } from './tools/generator.js';
import { uploadRuntime } from './upload-runtime.js';

const grantSchema = z.object({
  uploadUrl: z.url(),
  url: z.url(),
  expiresIn: z.number().positive(),
});
const inputSchema = z.object({
  contentType: z.string().regex(/^(video|audio|image)\/[\w.+-]+$/),
  size: z.number().int().positive(),
});
type Ticket = { destination: string; contentType: string; size: number; expiresAt: number };
const tickets = new Map<string, Ticket>();

/** A ticket grants one bounded PUT to one server-issued storage URL, never arbitrary proxying. */
export function relayUploadTool(
  tool: McpToolDefinition,
  origin: string,
  storageOrigin: string,
): McpToolDefinition {
  if (tool.name !== 'assets_create-upload-url') return tool;
  return {
    ...tool,
    handler: async (args, context) => {
      const input = inputSchema.parse(args);
      if (input.size > uploadRuntime.config.maxBytes)
        throw new Error(
          `This server supports uploads up to ${Math.floor(uploadRuntime.config.maxBytes / 1024 / 1024)} MB.`,
        );
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(key);
      if (tickets.size >= 128) throw new Error('Upload capacity is full. Try again shortly.');
      const signed = grantSchema.parse(await tool.handler(args, context));
      const destination = new URL(signed.uploadUrl);
      if (
        destination.protocol !== 'https:' ||
        destination.origin !== storageOrigin ||
        destination.username ||
        destination.password
      )
        throw new Error('Unexpected storage upload destination.');
      const token = randomBytes(32).toString('hex');
      const expiresIn = Math.min(signed.expiresIn, 300);
      process.stderr.write(
        JSON.stringify({
          event: 'app_upload_grant',
          storageOrigin: destination.origin,
          bytes: input.size,
        }) + '\n',
      );
      tickets.set(token, {
        destination: signed.uploadUrl,
        ...input,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return { ...signed, expiresIn, uploadUrl: `${origin}/app-upload?ticket=${token}` };
    },
  } as McpToolDefinition;
}

export const appUploadHandler: RequestHandler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const ticket = tickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    tickets.delete(token);
    res.status(403).json({ error: 'Upload permission expired. Choose the file again.' });
    return;
  }
  if (
    req.headers['content-type'] !== ticket.contentType ||
    Number(req.headers['content-length']) !== ticket.size
  ) {
    res.status(400).json({ error: 'Upload size or content type did not match.' });
    return;
  }
  tickets.delete(token);
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', abort);
  try {
    await uploadRuntime.run(
      async (signal) => {
        let size = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > ticket.size) callback(new Error('Upload exceeded its declared size.'));
            else callback(null, chunk);
          },
          flush(callback) {
            callback(size === ticket.size ? null : new Error('Incomplete upload.'));
          },
        });
        let resolveResponse!: () => void;
        let rejectResponse!: (error: Error) => void;
        const response = new Promise<void>((resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        });
        const upstream = request(
          ticket.destination,
          {
            method: 'PUT',
            signal,
            headers: { 'Content-Type': ticket.contentType, 'Content-Length': ticket.size },
          },
          (incoming) => {
            incoming.resume();
            process.stderr.write(
              JSON.stringify({
                event: 'app_upload_storage_response',
                status: incoming.statusCode,
              }) + '\n',
            );
            incoming.on('error', rejectResponse);
            incoming.on('end', () =>
              incoming.statusCode && incoming.statusCode >= 200 && incoming.statusCode < 300
                ? resolveResponse()
                : rejectResponse(new Error('Storage rejected the upload.')),
            );
          },
        );
        upstream.on('error', rejectResponse);
        // Both promises have rejection handlers immediately; backpressure bounds memory.
        await Promise.all([pipeline(req, bounded, upstream, { signal }), response]);
        uploadRuntime.recordUploadedBytes(size);
      },
      { signal: controller.signal },
    );
    res.status(204).end();
  } catch {
    if (!res.destroyed) res.status(502).json({ error: 'Upload did not complete. Please retry.' });
  } finally {
    res.off('close', abort);
  }
};
