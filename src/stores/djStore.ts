import { create } from 'zustand';
import { DeckAudioEngine } from '../lib/deckAudioEngine';
import { snapBPMToCommon, BPMInfo } from '../lib/bpmDetector';
import * as Tone from 'tone';

interface Track {
  name: string;
  bpm: number;
  key: string;
  url?: string;
  originalBPM?: number; // User-defined original BPM
}

interface DeckState {
  isPlaying: boolean;
  track: Track | null;
  pitch: number;
  eq: { low: number; mid: number; high: number };
  volume: number;
  fx: { filter: number; reverb: number; delay: number };
  isSyncing: boolean;
  bpmInfo?: BPMInfo;
}

interface DJState {
  // Audio engines
  deckA: DeckAudioEngine | null;
  deckB: DeckAudioEngine | null;
  
  // Deck states
  deckAState: DeckState;
  deckBState: DeckState;
  
  // Mixer
  crossfader: number;
  
  // Global BPM Control
  globalBPM: number;
  bpmSyncEnabled: boolean;
  
  // Transport for sync (Silent Backend Metronome)
  isTransportRunning: boolean;
  
  // BPM Input Modal State
  showBPMModal: boolean;
  pendingTrack: { deck: 'A' | 'B'; track: Track } | null;
  
  // Actions
  initializeAudio: () => Promise<void>;
  playDeck: (deck: 'A' | 'B') => void;
  pauseDeck: (deck: 'A' | 'B') => void;
  loadTrack: (deck: 'A' | 'B', track: Track) => Promise<void>;
  confirmTrackBPM: (bpm: number) => Promise<void>;
  setPitch: (deck: 'A' | 'B', value: number) => void;
  setEQ: (deck: 'A' | 'B', eq: { low: number; mid: number; high: number }) => void;
  setVolume: (deck: 'A' | 'B', value: number) => void;
  setCrossfader: (value: number) => void;
  setDeckFX: (deck: 'A' | 'B', fx: Partial<{ filter: number; reverb: number; delay: number }>) => void;
  scrubTrack: (deck: 'A' | 'B', velocity: number) => void;
  triggerBackspin: (deck: 'A' | 'B') => void;
  bendTempo: (deck: 'A' | 'B', rate: number) => void;
  syncDecks: () => void;
  setGlobalBPM: (bpm: number) => void;
  toggleBPMSync: () => void;
  syncDeckToGlobal: (deck: 'A' | 'B') => void;
  resetToOriginalBPMs: () => void;
  setShowBPMModal: (show: boolean) => void;
  playDeckOnNextBar: (deck: 'A' | 'B') => void; // New method for bar-aligned playback
  cleanup: () => void;
}

const defaultDeckState: DeckState = {
  isPlaying: false,
  track: null,
  pitch: 0,
  eq: { low: 50, mid: 50, high: 50 },
  volume: 75,
  fx: { filter: 50, reverb: 0, delay: 0 },
  isSyncing: false,
};

export const useDJStore = create<DJState>((set, get) => ({
  deckA: null,
  deckB: null,
  
  deckAState: defaultDeckState,
  deckBState: defaultDeckState,
  
  crossfader: 50,
  globalBPM: 128,
  bpmSyncEnabled: true,
  isTransportRunning: false,
  
  showBPMModal: false,
  pendingTrack: null,

  initializeAudio: async () => {
    try {
      await Tone.start();
      
      const deckA = new DeckAudioEngine();
      const deckB = new DeckAudioEngine();
      
      // Initialize silent backend metronome (Tone.Transport)
      Tone.Transport.bpm.value = 128;
      
      set({ deckA, deckB });
      
      console.log('🎧 DJ Audio System Initialized with Silent Backend Metronome');
    } catch (error) {
      console.error('Failed to initialize audio:', error);
    }
  },

  playDeck: (deck) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine && engine.isLoaded) {
      // Start silent backend metronome if not already running
      if (!state.isTransportRunning) {
        Tone.Transport.bpm.value = state.globalBPM;
        Tone.Transport.start();
        set({ isTransportRunning: true });
        console.log(`🎯 Silent Backend Metronome started at ${state.globalBPM} BPM`);
      }

      // For Deck A or when no other deck is playing, start immediately
      const otherDeckState = deck === 'A' ? state.deckBState : state.deckAState;
      if (deck === 'A' || !otherDeckState.isPlaying) {
        engine.play();
        
        const bpmInfo = engine.getBPMInfo();
        
        set({
          [deckState]: {
            ...state[deckState],
            isPlaying: true,
            bpmInfo
          },
        });
        
        console.log(`▶️ Deck ${deck} playing immediately`);
      } else {
        // For secondary decks when another deck is playing, use bar-aligned playback
        get().playDeckOnNextBar(deck);
      }
    }
  },

  playDeckOnNextBar: (deck) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (!engine || !engine.isLoaded) return;

    // Set deck to syncing state
    set({
      [deckState]: {
        ...state[deckState],
        isSyncing: true,
      },
    });

    // Calculate current transport position and beats until next bar
    const position = Tone.Transport.position;
    const [bars, beats, sixteenths] = position.split(':').map(Number);
    const currentBeat = beats + (sixteenths / 4); // Convert to decimal beats
    const beatsUntilNextBar = 4 - (currentBeat % 4);
    
    console.log(`⏱️ Current position: ${position}, waiting ${beatsUntilNextBar.toFixed(2)} beats for next bar`);

    // Schedule playback to start on the next bar (first beat)
    Tone.Transport.scheduleOnce(() => {
      if (engine.isLoaded) {
        engine.play();
        
        const bpmInfo = engine.getBPMInfo();
        
        set({
          [deckState]: {
            ...get()[deckState],
            isPlaying: true,
            isSyncing: false,
            bpmInfo
          },
        });
        
        console.log(`🎯 Deck ${deck} started on bar boundary - Perfect sync achieved!`);
      }
    }, `+${beatsUntilNextBar}n`);

    console.log(`🔄 Deck ${deck} will start in ${beatsUntilNextBar.toFixed(2)} beats on next bar`);
  },

  pauseDeck: (deck) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine) {
      engine.pause();
      set({
        [deckState]: {
          ...state[deckState],
          isPlaying: false,
        },
      });
    }
  },

  loadTrack: async (deck, track) => {
    const state = get();
    
    // Show BPM input modal for user to set original BPM
    set({
      showBPMModal: true,
      pendingTrack: { deck, track }
    });
  },

  confirmTrackBPM: async (originalBPM) => {
    const state = get();
    const { pendingTrack } = state;
    
    if (!pendingTrack) return;
    
    const { deck, track } = pendingTrack;
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine && track.url) {
      // Create track with user-defined original BPM
      const trackWithBPM = { ...track, originalBPM };
      
      const loaded = await engine.loadTrack(track.url, originalBPM);
      if (loaded) {
        // Calculate and apply playback rate for global BPM sync
        if (state.bpmSyncEnabled) {
          engine.setGlobalBPMSync(state.globalBPM, originalBPM);
          console.log(`🎯 Deck ${deck}: ${originalBPM} BPM → ${state.globalBPM} BPM`);
        }
        
        const bpmInfo = engine.getBPMInfo();
        
        set({
          [deckState]: {
            ...state[deckState],
            track: trackWithBPM,
            isPlaying: false,
            bpmInfo
          },
          showBPMModal: false,
          pendingTrack: null
        });
        
        console.log(`🎵 Loaded "${track.name}" to Deck ${deck} - Original: ${originalBPM} BPM, Global: ${state.globalBPM} BPM`);
      }
    }
  },

  setPitch: (deck, value) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine) {
      engine.setPitch(value);
      set({
        [deckState]: {
          ...state[deckState],
          pitch: value,
          bpmInfo: engine.getBPMInfo()
        },
      });
    }
  },

  setEQ: (deck, eq) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine) {
      engine.setEQ(eq.low, eq.mid, eq.high);
      set({
        [deckState]: {
          ...state[deckState],
          eq,
        },
      });
    }
  },

  setVolume: (deck, value) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    
    if (engine) {
      // Apply crossfader mixing with cosine curve
      const crossfaderNormalized = state.crossfader / 100;
      let finalVolume = value / 100;
      
      if (deck === 'A') {
        // Deck A fades out as crossfader moves right
        finalVolume *= Math.cos(crossfaderNormalized * 0.5 * Math.PI);
      } else {
        // Deck B fades out as crossfader moves left
        finalVolume *= Math.cos((1 - crossfaderNormalized) * 0.5 * Math.PI);
      }
      
      engine.setGain(finalVolume * 100);
      
      set({
        [deckState]: {
          ...state[deckState],
          volume: value,
        },
      });
    }
  },

  setCrossfader: (value) => {
    const state = get();
    set({ crossfader: value });
    
    // Update both deck volumes to apply crossfader
    get().setVolume('A', state.deckAState.volume);
    get().setVolume('B', state.deckBState.volume);
  },

  setDeckFX: (deck, fx) => {
    const state = get();
    const deckState = deck === 'A' ? 'deckAState' : 'deckBState';
    const engine = deck === 'A' ? state.deckA : state.deckB;
    
    const newDeckFX = { ...state[deckState].fx, ...fx };
    
    set({
      [deckState]: {
        ...state[deckState],
        fx: newDeckFX,
      },
    });

    // Apply FX to the engine
    if (engine) {
      if (fx.filter !== undefined) engine.setFilter(fx.filter);
      if (fx.reverb !== undefined) engine.setReverb(fx.reverb);
      if (fx.delay !== undefined) engine.setDelay(fx.delay);
    }
  },

  scrubTrack: (deck, velocity) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    
    if (engine && engine.isLoaded) {
      engine.scrub(velocity);
    }
  },

  triggerBackspin: (deck) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    
    if (engine) {
      engine.triggerBackspin();
      console.log(`🌀 Backspin triggered on Deck ${deck}`);
    }
  },

  bendTempo: (deck, rate) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    
    if (engine && engine.isLoaded) {
      engine.bendTempo(rate);
      console.log(`⏩ Tempo bend Deck ${deck}: ${rate}x`);
    }
  },

  syncDecks: () => {
    const state = get();
    const { deckA, deckB, deckAState, deckBState } = state;
    
    if (deckA && deckB && deckBState.track) {
      // Sync deck B to global BPM
      get().syncDeckToGlobal('B');
      
      // Set transport BPM to global BPM
      Tone.Transport.bpm.value = state.globalBPM;
      
      if (!state.isTransportRunning) {
        Tone.Transport.start();
        set({ isTransportRunning: true });
      }

      // Use bar-aligned playback for perfect sync
      get().playDeckOnNextBar('B');
    }
  },

  setGlobalBPM: (bpm) => {
    const state = get();
    const snappedBPM = Math.round(bpm); // Keep user's exact input
    
    set({ globalBPM: snappedBPM });
    
    // Update silent backend metronome BPM
    Tone.Transport.bpm.value = snappedBPM;
    
    // Update both decks if BPM sync is enabled
    if (state.bpmSyncEnabled) {
      if (state.deckA && state.deckAState.track?.originalBPM) {
        state.deckA.setGlobalBPMSync(snappedBPM, state.deckAState.track.originalBPM);
        set({
          deckAState: {
            ...state.deckAState,
            bpmInfo: state.deckA.getBPMInfo()
          }
        });
      }
      
      if (state.deckB && state.deckBState.track?.originalBPM) {
        state.deckB.setGlobalBPMSync(snappedBPM, state.deckBState.track.originalBPM);
        set({
          deckBState: {
            ...state.deckBState,
            bpmInfo: state.deckB.getBPMInfo()
          }
        });
      }
    }
    
    console.log(`🎯 Global BPM set to ${snappedBPM} - Silent Metronome updated`);
  },

  toggleBPMSync: () => {
    const state = get();
    const newSyncState = !state.bpmSyncEnabled;
    
    set({ bpmSyncEnabled: newSyncState });
    
    if (newSyncState) {
      // Enable sync - set both decks to global BPM
      if (state.deckA && state.deckAState.track?.originalBPM) {
        state.deckA.setGlobalBPMSync(state.globalBPM, state.deckAState.track.originalBPM);
        set({
          deckAState: {
            ...state.deckAState,
            bpmInfo: state.deckA.getBPMInfo()
          }
        });
      }
      
      if (state.deckB && state.deckBState.track?.originalBPM) {
        state.deckB.setGlobalBPMSync(state.globalBPM, state.deckBState.track.originalBPM);
        set({
          deckBState: {
            ...state.deckBState,
            bpmInfo: state.deckB.getBPMInfo()
          }
        });
      }
      
      console.log('🔄 Global BPM Sync enabled with Silent Metronome');
    } else {
      // Disable sync - reset to original BPMs
      if (state.deckA && state.deckAState.track?.originalBPM) {
        state.deckA.setGlobalBPMSync(state.deckAState.track.originalBPM, state.deckAState.track.originalBPM);
        set({
          deckAState: {
            ...state.deckAState,
            bpmInfo: state.deckA.getBPMInfo()
          }
        });
      }
      
      if (state.deckB && state.deckBState.track?.originalBPM) {
        state.deckB.setGlobalBPMSync(state.deckBState.track.originalBPM, state.deckBState.track.originalBPM);
        set({
          deckBState: {
            ...state.deckBState,
            bpmInfo: state.deckB.getBPMInfo()
          }
        });
      }
      
      console.log('⏸️ Global BPM Sync disabled');
    }
  },

  syncDeckToGlobal: (deck) => {
    const state = get();
    const engine = deck === 'A' ? state.deckA : state.deckB;
    const deckState = deck === 'A' ? state.deckAState : state.deckBState;
    
    if (engine && deckState.track?.originalBPM) {
      engine.setGlobalBPMSync(state.globalBPM, deckState.track.originalBPM);
      
      const newDeckState = deck === 'A' ? 'deckAState' : 'deckBState';
      set({
        [newDeckState]: {
          ...deckState,
          bpmInfo: engine.getBPMInfo()
        }
      });
      
      console.log(`🎯 Deck ${deck} synced to Global BPM: ${state.globalBPM}`);
    }
  },

  resetToOriginalBPMs: () => {
    const state = get();
    
    if (state.deckA && state.deckAState.track?.originalBPM) {
      state.deckA.setGlobalBPMSync(state.deckAState.track.originalBPM, state.deckAState.track.originalBPM);
      set({
        deckAState: {
          ...state.deckAState,
          bpmInfo: state.deckA.getBPMInfo()
        }
      });
    }
    
    if (state.deckB && state.deckBState.track?.originalBPM) {
      state.deckB.setGlobalBPMSync(state.deckBState.track.originalBPM, state.deckBState.track.originalBPM);
      set({
        deckBState: {
          ...state.deckBState,
          bpmInfo: state.deckB.getBPMInfo()
        }
      });
    }
    
    console.log('🔄 Reset all decks to original BPMs');
  },

  setShowBPMModal: (show) => {
    set({ showBPMModal: show });
    if (!show) {
      set({ pendingTrack: null });
    }
  },

  cleanup: () => {
    const state = get();
    state.deckA?.dispose();
    state.deckB?.dispose();
    Tone.Transport.stop();
    Tone.Transport.cancel();
    set({ isTransportRunning: false });
  },
}));