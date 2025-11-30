// @ts-ignore - osc has no type definitions
import osc from 'osc';
import { isNote, noteToMidi } from '@strudel/core/util.mjs';

// Default SuperDirt ports
const OSC_REMOTE_IP = '127.0.0.1';
const OSC_REMOTE_PORT = 57120;

let udpPort: any = null;
let isOpen = false;

/**
 * Initialize the OSC UDP port for sending messages to SuperDirt
 */
export function initOsc(remoteIp = OSC_REMOTE_IP, remotePort = OSC_REMOTE_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    if (udpPort && isOpen) {
      console.log('[osc] Already connected');
      resolve();
      return;
    }

    udpPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0, // Let the OS assign a port
      remoteAddress: remoteIp,
      remotePort: remotePort,
    });

    udpPort.on('ready', () => {
      isOpen = true;
      console.log(`[osc] Connected - sending to ${remoteIp}:${remotePort}`);
      resolve();
    });

    udpPort.on('error', (e: Error) => {
      console.error('[osc] Error:', e.message);
      reject(e);
    });

    udpPort.on('close', () => {
      isOpen = false;
      console.log('[osc] Connection closed');
    });

    udpPort.open();
  });
}

/**
 * Close the OSC connection
 */
export function closeOsc(): void {
  if (udpPort) {
    udpPort.close();
    udpPort = null;
    isOpen = false;
  }
}

/**
 * Check if OSC is connected
 */
export function isOscConnected(): boolean {
  return isOpen;
}

/**
 * Convert a hap value to SuperDirt OSC message arguments
 * Based on @strudel/osc's parseControlsFromHap
 */
function hapToOscArgs(hap: any, cps: number): any[] {
  const value = hap.value || {};
  const begin = hap.wholeOrPart?.()?.begin?.valueOf?.() ?? 0;
  const duration = hap.duration?.valueOf?.() ?? 1;
  const delta = duration / cps;

  // Build the controls object
  const controls: Record<string, any> = {
    cps,
    cycle: begin,
    delta,
    ...value,
  };

  // Handle note/midi conversion
  if (typeof controls.note !== 'undefined') {
    if (isNote(controls.note)) {
      controls.midinote = noteToMidi(controls.note, controls.octave || 3);
    } else if (typeof controls.note === 'number') {
      controls.midinote = controls.note;
    }
  }

  // Handle bank prefix
  if (controls.bank && controls.s) {
    controls.s = controls.bank + controls.s;
  }

  // Handle roomsize -> size alias
  if (controls.roomsize) {
    controls.size = controls.roomsize;
  }

  // Handle speed adjustment for unit=c
  if (controls.unit === 'c' && controls.speed != null) {
    controls.speed = controls.speed / cps;
  }

  // Flatten to array of [key, value, key, value, ...]
  const args: any[] = [];
  for (const [key, val] of Object.entries(controls)) {
    if (val !== undefined && val !== null) {
      args.push({ type: 's', value: key });
      
      // Determine OSC type
      if (typeof val === 'number') {
        args.push({ type: 'f', value: val });
      } else if (typeof val === 'string') {
        args.push({ type: 's', value: val });
      } else {
        args.push({ type: 's', value: String(val) });
      }
    }
  }

  return args;
}

/**
 * Send a hap to SuperDirt via OSC
 * @param hap The hap (event) from Strudel
 * @param deadline Seconds until the event should play
 * @param cps Cycles per second (tempo)
 */
let oscDebug = false;

export function setOscDebug(enabled: boolean): void {
  oscDebug = enabled;
}

export function sendHapToSuperDirt(hap: any, deadline: number, cps: number): void {
  if (!udpPort || !isOpen) {
    // Silently skip if OSC not connected
    return;
  }

  try {
    const args = hapToOscArgs(hap, cps);
    
    // Create timed OSC bundle
    const timestampMs = deadline * 1000;
    const msg = {
      timeTag: osc.timeTag(0, timestampMs),
      packets: [{
        address: '/dirt/play',
        args,
      }],
    };

    udpPort.send(msg);
    
    if (oscDebug) {
      const sound = hap.value?.s || hap.value?.note || '?';
      console.log(`[osc] Sent: ${sound} (deadline: ${deadline.toFixed(3)}s)`);
    }
  } catch (err) {
    console.error('[osc] Error sending hap:', err);
  }
}

/**
 * Send a simple test sound to verify connection
 */
export function sendTestSound(): void {
  if (!udpPort || !isOpen) {
    console.error('[osc] Not connected');
    return;
  }

  const args = [
    { type: 's', value: 's' },
    { type: 's', value: 'bd' },
    { type: 's', value: 'cps' },
    { type: 'f', value: 1 },
    { type: 's', value: 'delta' },
    { type: 'f', value: 1 },
    { type: 's', value: 'cycle' },
    { type: 'f', value: 0 },
  ];

  udpPort.send({
    address: '/dirt/play',
    args,
  });
  
  console.log('[osc] Test sound sent (bd)');
}
