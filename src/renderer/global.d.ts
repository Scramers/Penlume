import type { TTyporaApi } from '../shared/contracts'

declare global {
  interface Window {
    ttypora: TTyporaApi
  }
}

export {}

