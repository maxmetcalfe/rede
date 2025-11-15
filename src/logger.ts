type LogPayload = Record<string, unknown>;

export type LogEntry = {
	event: string;
	timestamp: string;
	payload?: LogPayload;
};

const MAX_BUFFER_SIZE = 500;
const eventBuffer: LogEntry[] = [];

const formatPayload = (payload?: LogPayload): string => {
	if (!payload || Object.keys(payload).length === 0) {
		return "";
	}
	return ` ${JSON.stringify(payload)}`;
};

export function logEvent(event: string, payload?: LogPayload): void {
	const timestamp = new Date().toISOString();
	const entry: LogEntry = { event, timestamp, payload };
	eventBuffer.push(entry);
	if (eventBuffer.length > MAX_BUFFER_SIZE) {
		eventBuffer.shift();
	}
	const prefix = `[bots:${event}]`;
	console.log(`${prefix} ${timestamp}${formatPayload(payload)}`);
}

export function getEventLog(): LogEntry[] {
	return [...eventBuffer];
}
