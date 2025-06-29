import * as Tone from 'tone';
import { calculatePlaybackRate, getBPMInfo, BPMInfo } from './bpmDetector';

export class DeckAudioEngine {
  private player: Tone.Player | null = null;
  private gain: Tone.Gain;
  private eq: { low: Tone.EQ3; mid: Tone.EQ3; high: Tone.EQ3 };
  private filter: Tone.Filter;
  private reverb: Tone.Reverb;
  private delay: Tone.FeedbackDelay;
  private pitchShift: Tone.PitchShift;
  private backspinPlayer: Tone.Player;
  public isLoaded: boolean = false;
  public isPlaying: boolean = false;
  private currentBPM: number = 128;
  private originalBPM: number = 128;
  private globalBPM: number = 128;
  private trackDuration: number = 0;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private cuePoint: number = 0;
  private basePlaybackRate: number = 1;
  private tempoBendTimeout: NodeJS.Timeout | null = null;
  
  // Enhanced beat snapping properties
  private isQueued: boolean = false;
  private isGridAligned: boolean = false;
  private nextBeatTime: number = 0;
  private beatInterval: number = 0;
  private gridUpdateInterval: NodeJS.Timeout | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private waveformData: Float32Array | null = null;
  private scheduledStartTime: number = 0;
  private scheduledOffset: number = 0;

  constructor() {
    // Initialize audio chain
    this.gain = new Tone.Gain(0.75);
    this.eq = {
      low: new Tone.EQ3(),
      mid: new Tone.EQ3(),
      high: new Tone.EQ3()
    };
    this.filter = new Tone.Filter(20000, 'lowpass');
    this.reverb = new Tone.Reverb(2);
    this.delay = new Tone.FeedbackDelay('8n', 0.3);
    this.pitchShift = new Tone.PitchShift();
    this.backspinPlayer = new Tone.Player('/backspin.mp3').toDestination();

    // Connect audio chain
    this.eq.low.chain(
      this.eq.mid, 
      this.eq.high, 
      this.filter, 
      this.reverb, 
      this.delay, 
      this.pitchShift, 
      this.gain
    );
    this.gain.toDestination();

    // Set initial FX wet values to 0
    this.reverb.wet.value = 0;
    this.delay.wet.value = 0;

    // Load backspin effect
    this.backspinPlayer.load('/backspin.mp3').catch(console.warn);
  }

  async loadTrack(url: string, userDefinedBPM: number): Promise<boolean> {
    try {
      if (this.player) {
        this.player.dispose();
      }

      this.player = new Tone.Player({
        url: url,
        loop: false,
        autostart: false
      });
      
      this.player.connect(this.eq.low);
      
      await this.player.load(url);
      this.trackDuration = this.player.buffer.duration;
      this.audioBuffer = this.player.buffer.get();
      this.generateWaveformData();
      
      this.isLoaded = true;
      this.isPlaying = false;
      this.pausedAt = 0;
      this.cuePoint = 0;
      this.scheduledOffset = 0;

      // Use user-defined BPM and auto-sync to 128 BPM
      this.originalBPM = userDefinedBPM;
      this.globalBPM = 128; // Always sync to 128 BPM
      this.currentBPM = this.globalBPM;
      this.beatInterval = 60 / this.globalBPM; // seconds per beat
      
      // Set initial playback rate for auto-sync
      this.updatePlaybackRate();
      
      // Sync player to transport for beat-aligned playback
      this.player.sync();
      
      // Mark as ready for beat-aligned sync
      this.prepareForBeatSync();
      
      console.log(`✅ Track loaded: ${url} (${this.trackDuration.toFixed(2)}s, ${this.originalBPM} BPM → ${this.globalBPM} BPM)`);
      return true;
    } catch (error) {
      console.error('❌ Failed to load track:', error);
      this.isLoaded = false;
      return false;
    }
  }

  /**
   * Generate waveform data for accurate visualization
   */
  private generateWaveformData(): void {
    if (!this.audioBuffer) return;

    const channelData = this.audioBuffer.getChannelData(0);
    const samples = 1024; // Number of waveform points
    const blockSize = Math.floor(channelData.length / samples);
    
    this.waveformData = new Float32Array(samples);
    
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(channelData[i * blockSize + j] || 0);
      }
      this.waveformData[i] = sum / blockSize;
    }
  }

  /**
   * 🎯 BEAT-ALIGNED SYNC PREPARATION: Calculate next bar start time
   */
  private prepareForBeatSync(): void {
    if (!this.player || !this.isLoaded) return;

    try {
      // Calculate next bar boundary (4 beats = 1 bar)
      const currentTime = Tone.Transport.seconds;
      const beatsPerBar = 4;
      const beatDuration = 60 / this.globalBPM; // seconds per beat
      const barDuration = beatDuration * beatsPerBar; // seconds per bar
      
      // Find current position in bars
      const currentBar = Math.floor(currentTime / barDuration);
      const nextBarTime = (currentBar + 1) * barDuration;
      
      this.nextBeatTime = nextBarTime;
      this.isQueued = true;
      this.isGridAligned = true;
      
      console.log(`🎯 Track queued for next bar at ${nextBarTime.toFixed(3)}s (current: ${currentTime.toFixed(3)}s)`);
      
    } catch (error) {
      console.error('Failed to prepare beat sync:', error);
      this.isGridAligned = false;
      this.isQueued = false;
    }
  }

  /**
   * Re-snap track to current grid position
   */
  async reSnapToGrid(): Promise<void> {
    if (!this.isLoaded) return;
    
    // Stop current playback if active
    if (this.isPlaying) {
      this.pause();
    }
    
    // Re-prepare for sync
    this.prepareForBeatSync();
    console.log('🔄 Track re-prepared for beat sync');
  }

  /**
   * Get current grid position information
   */
  getGridPosition(): { bar: number; beat: number; isAligned: boolean; isQueued: boolean } {
    if (!this.isLoaded) {
      return { bar: 1, beat: 1, isAligned: false, isQueued: false };
    }

    const currentTime = Tone.Transport.seconds;
    const beatDuration = 60 / this.globalBPM;
    const currentBeat = Math.floor(currentTime / beatDuration);
    const bar = Math.floor(currentBeat / 4) + 1;
    const beat = (currentBeat % 4) + 1;
    
    return { 
      bar, 
      beat, 
      isAligned: this.isGridAligned, 
      isQueued: this.isQueued 
    };
  }

  /**
   * Set global BPM sync - calculates playback rate to match global tempo
   */
  setGlobalBPMSync(globalBPM: number, originalBPM: number) {
    this.globalBPM = globalBPM;
    this.originalBPM = originalBPM;
    this.currentBPM = globalBPM;
    this.beatInterval = 60 / globalBPM;
    this.updatePlaybackRate();
    
    // Re-prepare for sync with new BPM
    if (this.isLoaded) {
      this.prepareForBeatSync();
    }
    
    console.log(`🎯 Global BPM Sync: ${originalBPM} → ${globalBPM} BPM (rate: ${this.basePlaybackRate.toFixed(3)}x)`);
  }

  /**
   * Update playback rate based on global BPM sync
   */
  private updatePlaybackRate() {
    if (this.player && this.originalBPM > 0) {
      this.basePlaybackRate = calculatePlaybackRate(this.originalBPM, this.globalBPM);
      this.player.playbackRate = this.basePlaybackRate;
      console.log(`🔄 Playback rate updated: ${this.basePlaybackRate.toFixed(3)}x (${this.originalBPM} → ${this.globalBPM} BPM)`);
    }
  }

  /**
   * Get BPM information
   */
  getBPMInfo(): BPMInfo {
    return getBPMInfo(this.originalBPM, this.globalBPM);
  }

  /**
   * ⚡ BEAT-ALIGNED INSTANT PLAY: Start at next bar boundary for perfect sync
   */
  play(fromCue: boolean = false) {
    if (this.player && this.isLoaded && !this.isPlaying) {
      // Ensure playback rate is correct before starting
      this.updatePlaybackRate();
      
      if (this.isQueued && this.isGridAligned && !fromCue) {
        // 🎯 BEAT-ALIGNED BAR SYNC PLAY
        const currentTime = Tone.Transport.seconds;
        const beatsPerBar = 4;
        const beatDuration = 60 / this.globalBPM;
        const barDuration = beatDuration * beatsPerBar;
        
        // Calculate next bar boundary
        const currentBar = Math.floor(currentTime / barDuration);
        const nextBarTime = (currentBar + 1) * barDuration;
        
        // Ensure the scheduled time is in the future
        const minStartTime = Tone.Transport.now() + 0.01; // Add small buffer
        const scheduledTime = Math.max(nextBarTime, minStartTime);
        
        // Schedule start at next bar or immediately if time has passed
        this.scheduledStartTime = scheduledTime;
        this.scheduledOffset = this.pausedAt;
        this.player.start(scheduledTime, this.pausedAt);
        this.startTime = scheduledTime - this.pausedAt;
        
        console.log(`⚡ Beat-sync play scheduled for: ${scheduledTime.toFixed(3)}s (transport: ${Tone.Transport.now().toFixed(3)}s)`);
        
        this.isQueued = false;
        this.isPlaying = true;
        
      } else {
        // Traditional play from current position
        const startPosition = fromCue ? this.cuePoint : this.pausedAt;
        const startTime = Tone.Transport.now();
        
        this.startTime = startTime - startPosition;
        this.scheduledOffset = startPosition;
        this.player.start(startTime, startPosition);
        this.isPlaying = true;
        this.isGridAligned = false; // No longer grid-aligned after manual play
        
        console.log(`▶️ Manual play from ${startPosition.toFixed(2)}s at transport time ${startTime.toFixed(3)}s`);
      }
      
      const bpmInfo = this.getBPMInfo();
      console.log(`🎵 Playing at ${this.currentBPM} BPM (${this.basePlaybackRate.toFixed(3)}x rate)`);
    }
  }

  pause() {
    if (this.player && this.isPlaying) {
      this.pausedAt = this.getCurrentTime();
      this.player.stop();
      this.isPlaying = false;
      this.isQueued = false;
      this.isGridAligned = false; // Lose grid alignment when paused manually
      console.log(`⏸️ Track paused at ${this.pausedAt.toFixed(2)}s`);
    }
  }

  seek(position: number) {
    if (this.player && this.isLoaded) {
      const wasPlaying = this.isPlaying;
      
      if (wasPlaying) {
        this.pause();
      }
      
      const clampedPosition = Math.max(0, Math.min(position, this.trackDuration));
      this.pausedAt = clampedPosition;
      this.isGridAligned = false; // Lose grid alignment when seeking
      this.isQueued = false;
      
      if (wasPlaying) {
        this.play();
      }
      
      console.log(`🎯 Seeked to ${clampedPosition.toFixed(2)}s`);
    }
  }

  /**
   * 🎛️ ENHANCED SCRUBBING: Proper directional scrubbing with audio feedback
   */
  scrub(velocity: number) {
    if (this.player && this.isLoaded) {
      const currentTime = this.getCurrentTime();
      
      // Enhanced scrub sensitivity and range
      const scrubSensitivity = 0.05; // Reduced for finer control
      const scrubAmount = velocity * scrubSensitivity;
      const newTime = Math.max(0, Math.min(currentTime + scrubAmount, this.trackDuration));
      
      // Update position
      this.pausedAt = newTime;
      this.isGridAligned = false; // Lose grid alignment when scrubbing
      this.isQueued = false;
      
      // If playing, update the playback position in real-time
      if (this.isPlaying) {
        // Stop current playback
        this.player.stop();
        
        // Start from new position immediately using current transport time
        const startTime = Tone.Transport.now();
        this.player.start(startTime, newTime);
        this.startTime = startTime - newTime;
        this.scheduledOffset = newTime;
        
        console.log(`🎛️ Live scrub to ${newTime.toFixed(3)}s (velocity: ${velocity.toFixed(3)}) at transport ${startTime.toFixed(3)}s`);
      } else {
        // When not playing, just update the position
        console.log(`🎛️ Scrub to ${newTime.toFixed(3)}s (velocity: ${velocity.toFixed(3)})`);
      }
    }
  }

  bendTempo(rate: number) {
    if (this.player && this.isLoaded) {
      // Apply tempo bend on top of global BPM sync rate
      this.player.playbackRate = this.basePlaybackRate * rate;
      
      // Clear any existing timeout
      if (this.tempoBendTimeout) {
        clearTimeout(this.tempoBendTimeout);
      }
      
      // If rate is not 1.0, it's a temporary bend
      if (rate !== 1.0) {
        this.tempoBendTimeout = setTimeout(() => {
          if (this.player) {
            this.player.playbackRate = this.basePlaybackRate;
          }
        }, 500);
      }
    }
  }

  setCuePoint(position?: number) {
    if (this.isLoaded) {
      this.cuePoint = position !== undefined ? position : this.getCurrentTime();
      console.log(`🎯 Cue point set at ${this.cuePoint.toFixed(2)}s`);
    }
  }

  jumpToCue() {
    if (this.isLoaded && this.cuePoint >= 0) {
      this.seek(this.cuePoint);
    }
  }

  getCurrentTime(): number {
    if (this.player && this.isLoaded) {
      if (this.isPlaying) {
        return (Tone.Transport.now() - this.startTime) * this.basePlaybackRate;
      } else {
        return this.pausedAt;
      }
    }
    return 0;
  }

  getDuration(): number {
    return this.trackDuration;
  }

  getBPM(): number {
    return this.currentBPM;
  }

  getOriginalBPM(): number {
    return this.originalBPM;
  }

  setPitch(cents: number) {
    if (this.pitchShift) {
      this.pitchShift.pitch = cents;
      
      if (this.player) {
        const pitchRatio = Math.pow(2, cents / 1200);
        // Apply pitch change on top of global BPM sync rate
        this.player.playbackRate = this.basePlaybackRate * pitchRatio;
      }
    }
  }

  setEQ(low: number, mid: number, high: number) {
    const lowDb = ((low - 50) / 50) * 15;
    const midDb = ((mid - 50) / 50) * 15;
    const highDb = ((high - 50) / 50) * 15;

    this.eq.low.low.rampTo(lowDb, 0.1);
    this.eq.mid.mid.rampTo(midDb, 0.1);
    this.eq.high.high.rampTo(highDb, 0.1);
  }

  setGain(value: number) {
    if (this.gain) {
      this.gain.gain.rampTo(value / 100, 0.1);
    }
  }

  setFilter(value: number) {
    if (this.filter) {
      const frequency = value <= 50 
        ? 20 + ((value / 50) * 19980)
        : 20000;
      
      this.filter.frequency.rampTo(frequency, 0.1);
    }
  }

  setReverb(value: number) {
    if (this.reverb) {
      this.reverb.wet.rampTo(value / 100, 0.1);
    }
  }

  setDelay(value: number) {
    if (this.delay) {
      this.delay.wet.rampTo(value / 100, 0.1);
    }
  }

  triggerBackspin() {
    if (this.isPlaying) {
      console.log('🌀 Triggering backspin effect');
      
      const currentTime = this.getCurrentTime();
      this.pause();
      
      if (this.backspinPlayer.loaded) {
        this.backspinPlayer.start();
      }
      
      setTimeout(() => {
        const newTime = Math.max(0, currentTime - 1.5);
        this.seek(newTime);
        this.play();
      }, 600);
    } else {
      if (this.backspinPlayer.loaded) {
        this.backspinPlayer.start();
      }
    }
  }

  syncToTransport() {
    if (this.player && this.isLoaded) {
      console.log('🎯 Deck ready for sync');
    }
  }

  /**
   * 📊 ENHANCED WAVEFORM: Generate accurate waveform based on actual audio data
   */
  getWaveform(): Float32Array {
    if (this.waveformData) {
      // Return actual waveform data from the audio buffer
      return this.waveformData;
    }
    
    // Fallback to generated waveform
    const waveform = new Float32Array(128);
    const time = this.getCurrentTime();
    const progress = time / this.trackDuration;
    
    for (let i = 0; i < waveform.length; i++) {
      const position = i / waveform.length;
      const amplitude = this.isPlaying ? 0.5 : 0.1;
      
      // Create a more realistic waveform pattern
      const frequency = 0.1 + (position * 0.2);
      const phase = time * 10 + position * Math.PI * 2;
      waveform[i] = Math.sin(phase * frequency) * amplitude * (1 - Math.abs(position - progress));
    }
    
    return waveform;
  }

  dispose() {
    if (this.tempoBendTimeout) {
      clearTimeout(this.tempoBendTimeout);
    }
    
    if (this.gridUpdateInterval) {
      clearInterval(this.gridUpdateInterval);
    }
    
    if (this.player) {
      this.player.dispose();
    }
    this.backspinPlayer.dispose();
    this.gain.dispose();
    this.eq.low.dispose();
    this.eq.mid.dispose();
    this.eq.high.dispose();
    this.filter.dispose();
    this.reverb.dispose();
    this.delay.dispose();
    this.pitchShift.dispose();
  }
}