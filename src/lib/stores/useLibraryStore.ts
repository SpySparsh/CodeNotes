import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type LibraryViewMode = 'grid' | 'list';

interface LibraryState {
  viewMode: LibraryViewMode;
  setViewMode: (mode: LibraryViewMode) => void;
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      viewMode: 'grid',
      setViewMode: (mode) => set({ viewMode: mode }),
    }),
    {
      name: 'codenotes-library-ui-preference',
    }
  )
);
