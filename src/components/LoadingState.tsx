interface LoadingStateProps {
  status?: string;
  message?: string;
}

export default function LoadingState({ status, message }: LoadingStateProps = {}) {
  const displayTitle =
    status === 'pending'
      ? 'Queued in Background'
      : status === 'processing'
      ? 'Analyzing Video & Generating Study Notes'
      : 'Generating Study Notes';

  const displayMessage =
    message ||
    (status === 'pending'
      ? 'Your generation job has been enqueued. Our background worker will pick it up in a moment.'
      : 'Our AI is analyzing the video, extracting key concepts, and formatting code blocks. This usually takes 15-30 seconds.');

  return (
    <div className="w-full max-w-3xl mx-auto mt-16 p-8 rounded-2xl border border-border/50 bg-card/20 backdrop-blur-md shadow-2xl flex flex-col items-center justify-center min-h-[400px]">
      <div className="relative w-24 h-24 mb-8">
        <div className="absolute inset-0 rounded-full border-t-2 border-cyan-500 animate-spin" style={{ animationDuration: '1.5s' }}></div>
        <div className="absolute inset-2 rounded-full border-r-2 border-purple-500 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '2s' }}></div>
        <div className="absolute inset-4 rounded-full border-b-2 border-indigo-500 animate-spin" style={{ animationDuration: '1s' }}></div>
      </div>
      <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-400 mb-4 text-center">
        {displayTitle}
      </h3>
      <p className="text-muted-foreground text-center max-w-md">
        {displayMessage}
      </p>
      
      <div className="mt-12 w-full max-w-md space-y-4 opacity-50">
        <div className="h-4 bg-gray-800 rounded-md animate-pulse w-3/4"></div>
        <div className="h-4 bg-gray-800 rounded-md animate-pulse w-full"></div>
        <div className="h-4 bg-gray-800 rounded-md animate-pulse w-5/6"></div>
        <div className="h-32 bg-gray-800/50 rounded-lg animate-pulse w-full border border-gray-700/50 mt-6"></div>
      </div>
    </div>
  );
}
