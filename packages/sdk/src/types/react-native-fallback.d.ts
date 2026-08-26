/**
 * Build-only fallback for the host-owned optional react-native peer.
 * `tsconfig.peer.json` excludes this file and compiles against real host types.
 */
declare module 'react-native' {
  import type { ComponentType } from 'react';

  export const ActivityIndicator: ComponentType<any>;
  export const Modal: ComponentType<any>;
  export const SafeAreaView: ComponentType<any>;
  export const ScrollView: ComponentType<any>;
  export const Text: ComponentType<any>;
  export const TouchableOpacity: ComponentType<any>;
  export const View: ComponentType<any>;
  export const Platform: { OS: string };
  export const StyleSheet: {
    create<T extends Record<string, unknown>>(styles: T): T;
  };
}
