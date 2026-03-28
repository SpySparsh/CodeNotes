import UrlInput from '@/components/UrlInput';
import { Bot, Code2, Zap } from 'lucide-react';

export default function Home() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 flex flex-col items-center justify-center min-h-[calc(100vh-4rem)]">
      {/* Hero Section */}
      <div className="text-center max-w-3xl mx-auto relative z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-50 border border-purple-100 text-purple-600 font-bold mb-8 shadow-sm">
          <Zap size={16} className="text-purple-500" /> <span className="text-sm tracking-wide">Powered by Gemini 2.0 AI</span>
        </div>
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-8 text-slate-900">
          Turn YouTube tutorials into{' '}
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-purple-600 to-indigo-600 pb-2">
            perfect code notes.
          </span>
        </h1>
        <p className="text-xl text-slate-600 mb-12 max-w-2xl mx-auto leading-relaxed font-medium">
          Tired of pausing and typing? Just paste a YouTube coding tutorial URL, and our AI will generate a structured summary, deep dive into the theory, and extract every snippet of code automatically inline.
        </p>

        {/* Input Component */}
        <div className="w-full relative z-20">
          <UrlInput />
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid md:grid-cols-3 gap-8 mt-32 w-full max-w-5xl mx-auto relative z-10">
        <div className="p-8 rounded-3xl bg-white border border-slate-100 shadow-xl shadow-slate-200/20 hover:border-purple-200 hover:shadow-purple-100/50 transition-all duration-300">
          <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 mb-6 shadow-inner">
            <Bot size={28} />
          </div>
          <h3 className="text-xl font-bold mb-3 text-slate-900">Smart Summaries</h3>
          <p className="text-slate-600 font-medium leading-relaxed">Get the executive summary and a technical deep dive into the concepts, isolating exactly what you need to learn.</p>
        </div>
        <div className="p-8 rounded-3xl bg-white border border-slate-100 shadow-xl shadow-slate-200/20 hover:border-purple-200 hover:shadow-purple-100/50 transition-all duration-300">
          <div className="w-14 h-14 rounded-2xl bg-purple-50 flex items-center justify-center text-purple-600 mb-6 shadow-inner">
            <Code2 size={28} />
          </div>
          <h3 className="text-xl font-bold mb-3 text-slate-900">Inline Code Extraction</h3>
          <p className="text-slate-600 font-medium leading-relaxed">Every function, class, and terminal command discussed is extracted and formatted beautifully directly within the theory.</p>
        </div>
        <div className="p-8 rounded-3xl bg-white border border-slate-100 shadow-xl shadow-slate-200/20 hover:border-purple-200 hover:shadow-purple-100/50 transition-all duration-300">
          <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 mb-6 shadow-inner">
            <Zap size={28} />
          </div>
          <h3 className="text-xl font-bold mb-3 text-slate-900">Comparison Tables</h3>
          <p className="text-slate-600 font-medium leading-relaxed">Automatically identifies comparisons in the video and generates clean markdown tables highlighting the key differences.</p>
        </div>
      </div>

      {/* Decorative Background Glows */}
      <div className="fixed top-20 left-1/4 w-[500px] h-[500px] bg-purple-200/40 rounded-full blur-[120px] pointer-events-none" />
      <div className="fixed bottom-20 right-1/4 w-[500px] h-[500px] bg-indigo-200/40 rounded-full blur-[120px] pointer-events-none" />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-white/50 rounded-full blur-[100px] pointer-events-none z-0" />
    </div>
  );
}
