import { ByteMeter, startEgressBroker } from '@atlas/ingest';
import { encodeFrame, FRAME } from '../protocol.js';
import { BrokerSpecSchema } from './spec.js';

/**
 * Egress broker entrypoint (plan §8.2-8.3, ADR-031). Runs in its own container, the only
 * one attached to both the acquisition network and an egress-capable network. On SIGTERM
 * (or when the byte budget trips) it reports its counters once and exits.
 */
async function main(): Promise<void> {
  const spec = BrokerSpecSchema.parse(JSON.parse(process.argv[2] ?? ''));
  const budget = new ByteMeter(spec.maxBytes);
  const broker = await startEgressBroker({ budget, host: '0.0.0.0', port: spec.port });
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const stats = broker.stats();
    await broker.close();
    process.stdout.write(encodeFrame({ type: FRAME.RESULT, value: { ok: true, bytes: stats.bytes, exceeded: stats.exceeded, tunnels: stats.tunnels, refused: stats.refused } }), () => process.exit(0));
  };
  process.on('SIGTERM', () => void finish());
  process.on('SIGINT', () => void finish());
  budget.onExceeded(() => void finish());
}

main().catch(() => process.exit(70));
