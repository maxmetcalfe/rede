import { DurableObject } from "cloudflare:workers";

type LogPayload = Record<string, unknown>;

export type LogEntry = {
	event: string;
	timestamp: string;
	payload?: LogPayload;
};

const MAX_BUFFER_SIZE = 500;
const EVENT_LOG_STORAGE_KEY = "entries";
const EVENT_LOG_DO_NAME = "global";
const eventBuffer: LogEntry[] = [];
let eventLogSink: ((entry: LogEntry) => void | Promise<void>) | undefined;

const formatPayload = (payload?: LogPayload): string => {
	if (!payload || Object.keys(payload).length === 0) {
		return "";
	}
	return ` ${JSON.stringify(payload)}`;
};

export class EventLogDurableObject extends DurableObject<Env> {
	protected readonly ctx: DurableObjectState<{}>;

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.ctx = ctx;
	}

	async appendEntry(entry: LogEntry): Promise<void> {
		const entries = await this.getEntries();
		entries.push(entry);
		if (entries.length > MAX_BUFFER_SIZE) {
			entries.splice(0, entries.length - MAX_BUFFER_SIZE);
		}
		await this.ctx.storage.put(EVENT_LOG_STORAGE_KEY, entries);
	}

	async getEntries(): Promise<LogEntry[]> {
		const stored = await this.ctx.storage.get<LogEntry[]>(EVENT_LOG_STORAGE_KEY);
		return Array.isArray(stored) ? stored : [];
	}

	async clearEntries(): Promise<void> {
		await this.ctx.storage.put(EVENT_LOG_STORAGE_KEY, []);
	}
}

export function configureEventLogSink(
	sink?: (entry: LogEntry) => void | Promise<void>,
): void {
	eventLogSink = sink;
}

export function logEvent(event: string, payload?: LogPayload): void {
	const timestamp = new Date().toISOString();
	const entry: LogEntry = { event, timestamp, payload };
	eventBuffer.push(entry);
	if (eventBuffer.length > MAX_BUFFER_SIZE) {
		eventBuffer.shift();
	}
	if (eventLogSink) {
		Promise.resolve(eventLogSink(entry)).catch((error) => {
			console.warn("Failed to persist event log entry:", error);
		});
	}
	const prefix = `[bots:${event}]`;
	console.log(`${prefix} ${timestamp}${formatPayload(payload)}`);
}

export function getEventLog(): LogEntry[] {
	return [...eventBuffer];
}

export function clearEventLog(): void {
	eventBuffer.length = 0;
}

export function createDurableEventLogSink(
	env: Pick<Env, "EVENT_LOG">,
): (entry: LogEntry) => Promise<void> {
	return async (entry: LogEntry) => {
		await env.EVENT_LOG.getByName(EVENT_LOG_DO_NAME).appendEntry(entry);
	};
}

export async function getDurableEventLog(env: Pick<Env, "EVENT_LOG">): Promise<LogEntry[]> {
	return env.EVENT_LOG.getByName(EVENT_LOG_DO_NAME).getEntries();
}

export async function clearDurableEventLog(env: Pick<Env, "EVENT_LOG">): Promise<void> {
	await env.EVENT_LOG.getByName(EVENT_LOG_DO_NAME).clearEntries();
}
