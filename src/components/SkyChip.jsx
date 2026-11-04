import { CloudLightning, CloudRain, CloudSnow, Moon, Sun, SunHorizon } from '@phosphor-icons/react';
import { clockText, useSky } from '../lib/sky.js';

const ICONS = { sun: Sun, horizon: SunHorizon, moon: Moon, rain: CloudRain, snow: CloudSnow, storm: CloudLightning };
const LABEL = { clear: 'Clear', rain: 'Rain', snow: 'Snow', storm: 'Storm' };

/** Local time on the mountain and the weather, e.g. "06:40 · Snow". */
export function SkyChip() {
  const minutes = useSky((s) => s.minutes);
  const icon = useSky((s) => s.icon);
  const weather = useSky((s) => s.weather);
  const Icon = ICONS[icon] || Sun;
  return (
    <div className="sky-chip" role="img" aria-label={`${clockText(minutes)} on the mountain, ${LABEL[weather] || 'Clear'}`}>
      <Icon size={16} weight="regular" aria-hidden="true" />
      <span className="sky-time">{clockText(minutes)}</span>
      <span className="sep" aria-hidden="true" />
      <span>{LABEL[weather] || 'Clear'}</span>
    </div>
  );
}
