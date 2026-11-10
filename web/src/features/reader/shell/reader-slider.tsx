import { useLayoutEffect, useRef } from "react"
import type { ComponentProps } from "react"
import { Slider } from "@/components/ui/slider"

/** 只补阅读控件的可访问名；官方组件、布局与样式保持逐字不变。 */
export function ReaderSlider(props: Omit<ComponentProps<typeof Slider>, "ref">) {
  const root = useRef<HTMLSpanElement>(null)
  const label = props["aria-label"], labelledby = props["aria-labelledby"]
  useLayoutEffect(() => {
    const thumbs = root.current?.querySelectorAll<HTMLElement>('[data-slot="slider-thumb"]')
    if (thumbs?.length !== 1) return
    const thumb = thumbs[0]
    const previous = [thumb.getAttribute("aria-label"), thumb.getAttribute("aria-labelledby")]
    if (label !== undefined) thumb.setAttribute("aria-label", label)
    if (labelledby !== undefined) thumb.setAttribute("aria-labelledby", labelledby)
    return () => {
      for (const [index, attribute] of ["aria-label", "aria-labelledby"].entries()) {
        const value = previous[index]
        if (value === null) thumb.removeAttribute(attribute)
        else thumb.setAttribute(attribute, value)
      }
    }
  }, [label, labelledby, props.value, props.defaultValue])
  return <Slider {...props} ref={root} />
}
