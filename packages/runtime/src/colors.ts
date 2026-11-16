import type { SensedColor } from "@mecahub/ir";
import { ColorId } from "@mecahub/lwp3";

/** IR color names to LWP3 color ids (same names as the lwp3 table; `none` is the "nothing seen" id). */
export const COLOR_ID_BY_NAME: Readonly<Record<SensedColor, ColorId>> = {
  black: ColorId.Black,
  pink: ColorId.Pink,
  purple: ColorId.Purple,
  blue: ColorId.Blue,
  lightBlue: ColorId.LightBlue,
  cyan: ColorId.Cyan,
  green: ColorId.Green,
  yellow: ColorId.Yellow,
  orange: ColorId.Orange,
  red: ColorId.Red,
  white: ColorId.White,
  none: ColorId.None,
};

const NAME_BY_ID = new Map<number, SensedColor>(
  (Object.entries(COLOR_ID_BY_NAME) as [SensedColor, ColorId][]).map(([name, id]) => [id, name]),
);

/** The IR name of an LWP3 color id. Unknown ids read as `none`. */
export const colorName = (id: number): SensedColor => NAME_BY_ID.get(id) ?? "none";
