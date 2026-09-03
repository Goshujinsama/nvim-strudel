import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifySuperDirtLoadSamples, setupOscPort } from '../sample-manager.js';

describe('native sample-bank reload protocol', () => {
  afterEach(() => setupOscPort(null));

  it('sends one exact bank directory instead of a file glob', async () => {
    const send = vi.fn();
    setupOscPort({ send });

    await expect(notifySuperDirtLoadSamples('/tmp/strudel-samples/piano1')).resolves.toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      address: '/strudel/loadSamples',
      args: [
        { type: 's', value: '/tmp/strudel-samples/piano1' },
        { type: 'i', value: 0 },
      ],
    });
  });
});
