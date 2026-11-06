// Capture côté animateur : audio de l'onglet Visio + micro, mélangés, découpés en tranches webm autonomes.

const OVERLAP_S = 0.3; // l'enregistreur suivant démarre juste avant l'arrêt du précédent
const VOICE_RMS = 0.006; // en dessous, on considère que c'est du silence (≈ -44 dBFS)
const MIN_VOICED_S = 0.6; // une tranche avec moins de parole que ça n'est pas envoyée
const MIME = 'audio/webm;codecs=opus';

export function captureSupport() {
  if (!navigator.mediaDevices?.getDisplayMedia) return 'Ce navigateur ne sait pas partager un onglet.';
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(MIME)) return 'Ce navigateur ne sait pas enregistrer en webm/opus.';
  if (/firefox/i.test(navigator.userAgent)) return 'Firefox ne capture pas le son d’un onglet : utilise Chrome ou Edge.';
  return null;
}

export class Capture {
  /**
   * @param {{ upload: (blob: Blob, seq: number, durationMs: number) => Promise<void>, chunkSeconds: number,
   *           onStatus: (s: object) => void, onEnd: (reason?: string) => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.status = { running: false, sent: 0, silent: 0, failed: 0, level: 0, micOk: false };
  }

  emit(patch) {
    Object.assign(this.status, patch);
    this.opts.onStatus({ ...this.status });
  }

  async start() {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: true, // obligatoire pour l'API ; la piste est désactivée aussitôt
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
    if (!display.getAudioTracks().length) {
      display.getTracks().forEach((t) => t.stop());
      throw new Error('Aucun son partagé. Choisis l’onglet Visio et coche « Partager aussi le son de l’onglet ».');
    }
    display.getVideoTracks().forEach((t) => (t.enabled = false));

    let mic = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      // On continue avec le seul onglet : les autres participants restent captés.
    }

    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/assets/audio-clock.js');
    const clock = new AudioWorkletNode(ctx, 'audio-clock', { outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(clock);
    if (mic) ctx.createMediaStreamSource(mic).connect(clock);
    clock.connect(dest);

    this.display = display;
    this.mic = mic;
    this.ctx = ctx;
    this.clock = clock;
    this.dest = dest;
    this.seq = 0;
    this.current = this.newRecorder(0);
    this.next = null;

    for (const t of display.getTracks()) t.addEventListener('ended', () => this.stop('Partage de l’onglet arrêté.'));
    clock.port.onmessage = (e) => this.tick(e.data);
    this.emit({ running: true, micOk: Boolean(mic) });
  }

  newRecorder(startS) {
    const rec = new MediaRecorder(this.dest.stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
    const r = { rec, startS, voicedS: 0, parts: [], seq: ++this.seq };
    rec.ondataavailable = (e) => e.data.size && r.parts.push(e.data);
    rec.start();
    return r;
  }

  tick({ seconds, rms }) {
    this.emit({ level: rms });
    if (!this.current) return;
    if (rms > VOICE_RMS) {
      this.current.voicedS += 0.1;
      if (this.next) this.next.voicedS += 0.1;
    }
    const elapsed = seconds - this.current.startS;
    const chunk = this.opts.chunkSeconds;
    if (!this.next && elapsed >= chunk - OVERLAP_S) this.next = this.newRecorder(seconds);
    if (elapsed >= chunk) {
      this.finish(this.current, elapsed);
      this.current = this.next;
      this.next = null;
    }
  }

  finish(r, elapsedS) {
    r.rec.onstop = async () => {
      if (r.voicedS < MIN_VOICED_S) {
        this.emit({ silent: this.status.silent + 1 });
        return;
      }
      const blob = new Blob(r.parts, { type: 'audio/webm' });
      try {
        await this.opts.upload(blob, r.seq, Math.round(elapsedS * 1000));
        this.emit({ sent: this.status.sent + 1 });
      } catch {
        try {
          await this.opts.upload(blob, r.seq, Math.round(elapsedS * 1000));
          this.emit({ sent: this.status.sent + 1 });
        } catch {
          this.emit({ failed: this.status.failed + 1 });
        }
      }
    };
    if (r.rec.state !== 'inactive') r.rec.stop();
  }

  stop(reason) {
    if (!this.status.running) return;
    const elapsed = this.ctx ? this.ctx.currentTime - (this.current?.startS ?? 0) : 0;
    if (this.current) this.finish(this.current, elapsed);
    if (this.next) this.next.rec.stop();
    this.current = this.next = null;
    if (this.clock) this.clock.port.onmessage = null;
    this.display?.getTracks().forEach((t) => t.stop());
    this.mic?.getTracks().forEach((t) => t.stop());
    // Laisse le dernier enregistreur vider ses données avant de fermer le contexte audio.
    setTimeout(() => this.ctx?.close(), 500);
    this.emit({ running: false, level: 0 });
    this.opts.onEnd(reason);
  }
}
