// AudioWorklet : laisse passer le son et envoie toutes les ~100 ms le temps écoulé et le niveau (RMS).
// Il tourne sur le fil audio, que Chrome ne ralentit pas quand l'onglet est en arrière-plan,
// contrairement à setTimeout. C'est donc lui qui cadence les tranches.
class AudioClock extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.sumSq = 0;
    this.count = 0;
    this.every = Math.round(sampleRate / 10);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = input[0]?.length ?? 128;
    for (let c = 0; c < output.length; c++) {
      if (input[c]) output[c].set(input[c]);
    }
    if (input[0]) {
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < input.length; c++) v += input[c][i];
        v /= input.length;
        this.sumSq += v * v;
      }
    }
    this.count += n;
    this.frames += n;
    if (this.count >= this.every) {
      this.port.postMessage({ seconds: this.frames / sampleRate, rms: Math.sqrt(this.sumSq / this.count) });
      this.sumSq = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('audio-clock', AudioClock);
