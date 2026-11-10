import { useEffect, useState } from 'react';

import { Icon } from '@components';
import { isTransparentColor } from '@constants';
import { peekMerchantImageSrc, resolveMerchantImageSrc } from '@services';
import { useAuthStore } from '@store';
import { cn } from '@utils';

type MerchantVisualProps = {
  name: string;
  color: string;
  icon?: string | null;
  imageUrl?: string | null;
  /** Aperçu local (blob:) — prioritaire sur imageUrl. */
  localImageSrc?: string | null;
  className?: string;
  iconClassName?: string;
  /** Désactive le `title` natif (ex. quand un Tooltip enveloppe déjà). */
  showNativeTitle?: boolean;
};

/** Avatar enseigne (icône ou image auth, avec cache mémoire partagé). */
export function MerchantVisual({
  name,
  color,
  icon,
  imageUrl,
  localImageSrc,
  className,
  iconClassName = 'text-icon',
  showNativeTitle = true,
}: MerchantVisualProps) {
  const token = useAuthStore((state) => state.token);
  const [blobUrl, setBlobUrl] = useState<string | null>(() =>
    localImageSrc || !imageUrl ? null : peekMerchantImageSrc(imageUrl),
  );
  const transparent = isTransparentColor(color);
  const displaySrc = localImageSrc || blobUrl;

  useEffect(() => {
    if (localImageSrc || !imageUrl || !token) {
      setBlobUrl(null);
      return;
    }

    const cached = peekMerchantImageSrc(imageUrl);
    if (cached) setBlobUrl(cached);

    let cancelled = false;
    void resolveMerchantImageSrc(imageUrl, token).then((url) => {
      if (!cancelled) setBlobUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, localImageSrc, token]);

  return (
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control',
        transparent ? 'text-fg-primary' : 'text-white',
        className,
      )}
      style={transparent ? undefined : { backgroundColor: color }}
      title={showNativeTitle ? name : undefined}
    >
      {displaySrc ? (
        <img
          src={displaySrc}
          alt=""
          className={cn('size-full', transparent ? 'object-contain p-0.5' : 'object-cover')}
        />
      ) : (
        <Icon name={icon || 'storefront'} className={iconClassName} />
      )}
    </span>
  );
}
