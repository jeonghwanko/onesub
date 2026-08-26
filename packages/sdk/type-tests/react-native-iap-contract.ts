import * as ReactNativeIap from 'react-native-iap';
import type { ReactNativeIapAdapter } from '../src/iapAdapter.js';

// Compilation is the assertion: each matrix-selected real peer must accept
// every method and request shape OneSub consumes at runtime.
const adapter: ReactNativeIapAdapter = ReactNativeIap;
void adapter;
