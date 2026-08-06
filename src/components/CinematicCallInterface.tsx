// src/components/CinematicCallInterface.tsx
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, Mic, Globe, Activity, Zap, ShieldCheck } from 'lucide-react';

interface CallState {
  status: 'idle' | 'connecting' | 'active' | 'browsing' | 'ended';
  duration: number;
  targetNumber: string;
  aiModel: string;
}

export const CinematicCallInterface: React.FC = () => {
  const [call, setCall] = useState<CallState>({
    status: 'idle',
    duration: 0,
    targetNumber: '',
    aiModel: 'Gemini-2.0-Flash-Live'
  });

  const startCall = (number: string) => {
    setCall({ ...call, status: 'connecting', targetNumber: number });
    setTimeout(() => setCall({ ...call, status: 'active' }), 2000);
  };

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-sans">
      {/* پس‌زمینه متحرک سینمایی */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-black to-black animate-pulse-slow" />
      
      {/* افکت ذرات معلق */}
      <div className="absolute inset-0 opacity-30">
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-cyan-400 rounded-full"
            initial={{ x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight }}
            animate={{ 
              y: [null, Math.random() * -100],
              opacity: [0, 1, 0]
            }}
            transition={{ duration: Math.random() * 5 + 5, repeat: Infinity }}
          />
        ))}
      </div>

      {/* پنل اصلی شیشه‌ای */}
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="relative z-10 flex flex-col items-center justify-center h-full backdrop-blur-md bg-white/5 border border-white/10 rounded-3xl m-4 shadow-2xl shadow-cyan-500/20"
      >
        {/* نشانگر وضعیت هوش مصنوعی */}
        <div className="mb-8 flex items-center gap-3 px-6 py-3 rounded-full bg-black/40 border border-cyan-500/30">
          <Activity className="w-5 h-5 text-cyan-400 animate-pulse" />
          <span className="text-cyan-100 font-mono tracking-widest uppercase text-sm">
            {call.aiModel}
          </span>
          <ShieldCheck className="w-5 h-5 text-green-500" />
        </div>

        {/* ویژوالایزر صوتی مرکزی */}
        <div className="relative w-64 h-64 mb-12">
          <AnimatePresence>
            {call.status === 'active' && (
              <>
                {[...Array(5)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute inset-0 border-2 border-cyan-500/30 rounded-full"
                    animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                    transition={{ duration: 2, delay: i * 0.2, repeat: Infinity }}
                  />
                ))}
              </>
            )}
          </AnimatePresence>
          <div className="absolute inset-0 flex items-center justify-center">
            {call.status === 'idle' && <Phone className="w-24 h-24 text-gray-500" />}
            {call.status === 'connecting' && <Zap className="w-24 h-24 text-yellow-400 animate-spin" />}
            {call.status === 'active' && <Mic className="w-24 h-24 text-cyan-400 animate-pulse" />}
          </div>
        </div>

        {/* اطلاعات تماس */}
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-2">
            {call.status === 'idle' ? 'آماده تماس' : call.targetNumber || 'در حال اتصال...'}
          </h2>
          <p className="text-cyan-200/70 font-mono">
            {call.status === 'active' ? 'متصل به شبکه برق ایلام' : 'سیستم بومی فعال است'}
          </p>
        </div>

        {/* کنترل‌ها */}
        <div className="flex gap-6">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => startCall('09180000000')}
            className="p-6 rounded-full bg-gradient-to-br from-cyan-600 to-blue-700 shadow-lg shadow-cyan-500/50 hover:shadow-cyan-400/70 transition-all"
          >
            <Phone className="w-8 h-8 text-white" />
          </motion.button>
          
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            className="p-6 rounded-full bg-gradient-to-br from-purple-600 to-indigo-700 shadow-lg shadow-purple-500/50 hover:shadow-purple-400/70 transition-all"
          >
            <Globe className="w-8 h-8 text-white" />
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
};