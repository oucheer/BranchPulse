import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import type { ComponentType } from 'react'

export interface CardSpreadItem {
  to: string
  label: string
  icon: ComponentType<any>
  end?: boolean
  badge?: number
}

interface CardSpreadProps {
  items: CardSpreadItem[]
}

export default function CardSpread({ items }: CardSpreadProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const collapsedHeight = 68
  const expandedHeight = items.length * 38 + 8

  return (
    <motion.div
      className="relative"
      initial={false}
      animate={{ height: open ? expandedHeight : collapsedHeight }}
      transition={{ type: 'spring', stiffness: 240, damping: 26 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {items.map((item, index) => (
        <motion.div
          key={item.to}
          className={open ? 'absolute left-0 right-0' : 'absolute left-0 right-0 top-0'}
          initial={false}
          animate={{
            y: open ? index * 38 : Math.min(index, 2) * 4,
            rotate: open ? (index % 2 ? 0 : -0.25) : index % 2 ? 1.2 : -1.2,
            scale: open ? 1 : 1 - Math.min(index, 2) * 0.015,
            opacity: open ? 1 : 1 - Math.min(index, 2) * 0.08,
            zIndex: open ? index : items.length - index
          }}
          transition={{ type: 'spring', stiffness: 270, damping: 24 }}
        >
          <NavLink
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `group flex h-8 items-center gap-2 rounded-md border px-2 text-[12px] font-medium shadow-sm transition-colors ${
                isActive
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-line bg-surface text-muted hover:border-primary/30 hover:text-canvas-fg'
              }`
            }
          >
            <item.icon size={14} />
            <span className="truncate">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <span className="ml-auto rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{item.badge}</span>
            ) : null}
          </NavLink>
        </motion.div>
      ))}
    </motion.div>
  )
}
