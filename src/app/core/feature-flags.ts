import { InjectionToken } from '@angular/core';

export type FeatureFlags = {
  search: boolean;
  markers: boolean;
  comments: boolean;
  ocr: boolean;
  compare: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  search: true,
  markers: true,
  comments: true,
  ocr: true,
  compare: true
};

export const FEATURE_FLAGS = new InjectionToken<FeatureFlags>('FEATURE_FLAGS');
