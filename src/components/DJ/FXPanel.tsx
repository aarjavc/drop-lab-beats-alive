import React from 'react';
import { motion } from 'framer-motion';
import InfoTooltip from '../InfoTooltip';
import { useDJStore } from '../../stores/djStore';

const FXPanel = () => {
  const { fx, setFX } = useDJStore();

  const Knob = ({
    value,
    onChange,
    label,
    tooltip
  }: {
    value: number;
    onChange: (value: number) => void;
    label: string;
    tooltip: string;
  }) => {
    const rotation = (value / 100) * 270 - 135;

    return (
      <div className="flex flex-col items-center space-y-2">
        <div className="relative w-16 h-16">
          <div
            className="w-16 h-16 rounded-full border-4 border-blue-500 bg-gray-800 relative cursor-pointer shadow-lg hover:shadow-blue-500/25 transition-all"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
              const degrees = (angle * 180 / Math.PI + 90 + 360) % 360;
              const normalizedValue = Math.max(0, Math.min(100, (degrees / 270) * 100));
              onChange(normalizedValue);
            }}
          >
            <div
              className="absolute w-1 h-6 bg-blue-400 top-1 left-1/2 transform -translate-x-1/2 origin-bottom rounded-full transition-transform"
              style={{ transform: `translateX(-50%) rotate(${rotation}deg)` }}
            />
            {/* Glow effect when active */}
            {value > 10 && (
              <div className="absolute inset-0 rounded-full bg-blue-500/20 animate-pulse" />
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-sm text-white font-semibold">{label}</span>
          <InfoTooltip content={tooltip} />
        </div>
        <div className="text-xs text-white">{Math.round(value)}%</div>
      </div>
    );
  };

  return (
    <div className="bg-gray-900 rounded-xl p-6 border border-blue-500/30">
      <div className="text-center mb-6">
        <h3 className="text-lg font-bold text-white">FX Panel</h3>
      </div>

      {/* FX Controls */}
      <div className="grid grid-cols-3 gap-6 mb-6">
        <Knob
          value={fx.filter}
          onChange={(value) => setFX({ filter: value })}
          label="FILTER"
          tooltip="Sweep from full bass (left) to full treble (right). Center is neutral."
        />
        <Knob
          value={fx.reverb}
          onChange={(value) => setFX({ reverb: value })}
          label="REVERB"
          tooltip="Add space and echo to your sound. Great for breakdowns and transitions."
        />
        <Knob
          value={fx.delay}
          onChange={(value) => setFX({ delay: value })}
          label="DELAY"
          tooltip="Repeat sound in rhythmic bursts. Perfect for creating tension and drops."
        />
      </div>

      {/* Assignment Buttons */}
      <div className="space-y-3">
        <div className="text-xs text-white text-center font-semibold">ASSIGN FX TO:</div>
        <div className="flex justify-center gap-2">
          {(['A', 'B', 'BOTH'] as const).map((option) => (
            <motion.button
              key={option}
              onClick={() => setFX({ assignedTo: option })}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className={`px-4 py-2 rounded-lg border font-semibold transition-all ${fx.assignedTo === option
                  ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/25'
                  : 'border-blue-500/30 text-white hover:border-blue-500 hover:bg-blue-600/10'
                }`}
            >
              {option}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Visual FX Indicator */}
      {(fx.filter !== 50 || fx.reverb > 0 || fx.delay > 0) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-4 p-3 bg-blue-600/20 border border-blue-500/30 rounded-lg text-center"
        >
          <div className="text-sm text-white">
            FX Active on Deck {fx.assignedTo}
          </div>
          <div className="text-xs text-white mt-1">
            {fx.filter !== 50 && `Filter: ${Math.round(fx.filter)}% `}
            {fx.reverb > 0 && `Reverb: ${Math.round(fx.reverb)}% `}
            {fx.delay > 0 && `Delay: ${Math.round(fx.delay)}%`}
          </div>
        </motion.div>
      )}
    </div>
  );
};

export default FXPanel;