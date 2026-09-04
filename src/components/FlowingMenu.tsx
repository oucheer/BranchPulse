import { useEffect, useRef, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import './FlowingMenu.css'

interface FlowingMenuItem {
  to: string
  label: string
  icon: string
  description: string
}

const items: FlowingMenuItem[] = [
  { to: '/branches', label: '分支', icon: '⑂', description: '查看和治理分支' },
  { to: '/monitoring', label: '监控', icon: '◉', description: '巡查和提醒' },
  { to: '/reports', label: '报告', icon: '▤', description: '生成和导出' },
  { to: '/scheduler', label: '定时', icon: '◷', description: '自动化任务' },
  { to: '/notifications', label: '通知', icon: '✉', description: '发送记录' },
  { to: '/audit', label: '审计', icon: '☰', description: '操作日志' }
]

function closestEdge(x: number, y: number, width: number, height: number): 'top' | 'bottom' {
  const top = (x - width / 2) ** 2 + y ** 2
  const bottom = (x - width / 2) ** 2 + (y - height) ** 2
  return top < bottom ? 'top' : 'bottom'
}

function MenuItem({ item }: { item: FlowingMenuItem }): JSX.Element {
  const navigate = useNavigate()
  const itemRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)

  const enter = (event: MouseEvent<HTMLButtonElement>): void => {
    if (!itemRef.current || !overlayRef.current || !innerRef.current) return
    const rect = itemRef.current.getBoundingClientRect()
    const edge = closestEdge(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
    gsap.timeline({ defaults: { duration: 0.55, ease: 'expo' } })
      .set(overlayRef.current, { yPercent: edge === 'top' ? -101 : 101 }, 0)
      .set(innerRef.current, { yPercent: edge === 'top' ? 101 : -101 }, 0)
      .to([overlayRef.current, innerRef.current], { yPercent: 0 }, 0)
  }

  const leave = (event: MouseEvent<HTMLButtonElement>): void => {
    if (!itemRef.current || !overlayRef.current || !innerRef.current) return
    const rect = itemRef.current.getBoundingClientRect()
    const edge = closestEdge(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
    gsap.timeline({ defaults: { duration: 0.5, ease: 'expo' } })
      .to(overlayRef.current, { yPercent: edge === 'top' ? -101 : 101 }, 0)
      .to(innerRef.current, { yPercent: edge === 'top' ? 101 : -101 }, 0)
  }

  useEffect(() => {
    const inner = innerRef.current
    if (!inner) return
    const tween = gsap.to(inner, { xPercent: -50, duration: 18, ease: 'none', repeat: -1 })
    return () => {
      tween.kill()
    }
  }, [])

  return (
    <div ref={itemRef} className="flowing-menu__item">
      <button type="button" className="flowing-menu__link" onClick={() => navigate(item.to)} onMouseEnter={enter} onMouseLeave={leave}>
        <span className="flowing-menu__icon">{item.icon}</span>
        <span className="flowing-menu__text">{item.label}</span>
        <span className="flowing-menu__description">{item.description}</span>
      </button>
      <div ref={overlayRef} className="flowing-menu__overlay">
        <div ref={innerRef} className="flowing-menu__inner" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span key={index}>{item.label}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function FlowingMenu(): JSX.Element {
  return (
    <div className="flowing-menu" aria-label="功能导航">
      <nav>
        {items.map((item) => (
          <MenuItem key={item.to} item={item} />
        ))}
      </nav>
    </div>
  )
}
