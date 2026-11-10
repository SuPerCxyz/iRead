import { useEffect, useRef, type ComponentProps } from "react"

import { Slider } from "@/components/ui/slider"

type SliderProps = ComponentProps<typeof Slider>

interface LabeledSliderProps extends SliderProps {
  label: string
  descriptionId?: string
}

export function LabeledSlider({
  label,
  descriptionId,
  id,
  ...sliderProps
}: LabeledSliderProps) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const thumb = container.current?.querySelector<HTMLElement>(
      '[data-slot="slider-thumb"]',
    )
    if (!thumb) {
      return
    }
    thumb.setAttribute("aria-label", label)
    if (id) {
      thumb.id = id
    }
    if (descriptionId) {
      thumb.setAttribute("aria-describedby", descriptionId)
    } else {
      thumb.removeAttribute("aria-describedby")
    }
  }, [descriptionId, id, label])

  return (
    <div ref={container}>
      <Slider {...sliderProps} />
    </div>
  )
}
