import { NavLink } from 'react-router';

import { Icon } from '@components';
import {
  APP_ROUTE,
  NAV_ICON_BOX_ACTIVE,
  NAV_ICON_BOX_BASE,
  NAV_ICON_BOX_INACTIVE,
  NAV_ITEM_ACTIVE,
  NAV_ITEM_INACTIVE,
  NAV_ITEM_VARIANT_CLASSES,
} from '@constants';
import type { INavItem, NavItemVariant } from '@app-types';
import { cn } from '@utils';

interface INavItemProps {
  variant: NavItemVariant;
  item: INavItem;
}

export function NavItem({ variant, item }: INavItemProps) {
  const classes = NAV_ITEM_VARIANT_CLASSES[variant];

  return (
    <NavLink
      to={item.to}
      end={item.to === APP_ROUTE.home}
      className={({ isActive }) => cn(classes.base, isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE)}
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(NAV_ICON_BOX_BASE, classes.iconBox, isActive ? NAV_ICON_BOX_ACTIVE : NAV_ICON_BOX_INACTIVE)}
          >
            <Icon name={item.icon} filled={isActive} className="text-icon" />
          </span>
          <span className="max-w-full truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}
