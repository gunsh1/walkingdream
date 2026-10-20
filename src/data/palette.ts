/**
 * 参考画像から目視で抽出した色。各ワールドはここからしか色を取らない。
 * 数値は sRGB の 16進。マテリアル側で THREE.Color(hex) にして使う。
 */

export const POOL = {
  waterDeep: 0x4e9ea6,
  waterShallow: 0x9ed5d2,
  waterFoam: 0xdff2ef,
  tile: [0xf2b7c8, 0xb9a8d0, 0xf0e7a0, 0xb7d9cf, 0xf4ede0, 0x9fb6cf, 0xf0a99b, 0xe6dcc6],
  tileGrout: 0xe8e2d6,
  copingTop: 0xdfe6e6,
  copingSide: 0xc3d2d4,
  capRed: 0xb8392f,
  capSpot: 0xf6f2ea,
  stalk: 0xefe6d8,
  columnPink: 0xf0a6b8,
  columnPinkDark: 0xd98b9f,
  wallYellow: 0xdfe3a0,
  wallPink: 0xf3c3cf,
  wallLilac: 0xb0a6c8,
  wallMint: 0xbfdcd4,
  ceiling: 0xb2bcc0,
  duct: 0x8f9aa0,
  pipe: 0x7f8a90,
  rock: 0xcbbfae,
  rockDark: 0xa2947f,
  lightWarm: 0xfff4dc,
  lightCool: 0xdff0ff,
  voidBlack: 0x05070a,
} as const

export const SPIRAL = {
  clayLight: 0xe9e7e2,
  clayMid: 0xc6c3bd,
  clayShadow: 0x8b8781,
  clayDeep: 0x5f5c57,
  grout: 0x9c9a95,
  water: 0xb2b0ab,
  crack: 0xfff8e6,
} as const

export const HILL = {
  skyTop: 0x0f63d6,
  skyBottom: 0x53a8ee,
  grassLight: 0x74c24d,
  grassDark: 0x4e9b36,
  road: 0xe9caa1,
  roadEdge: 0xd3ad82,
  fence: 0xd8c9a8,
  tree: 0x3f7a34,
  glitchVoid: 0x000000,
} as const

export const LOT = {
  skyTop: 0x8aa6d6,
  skyBottom: 0xf0c3b4,
  cloudLit: 0xf7a8b8,
  cloudWarm: 0xfbd0a4,
  asphalt: 0x585d64,
  asphaltWorn: 0x6a6f76,
  line: 0xd6c79c,
  storeWall: 0xf0eae3,
  storeGlass: 0xbcd6cf,
  storeInner: 0xfdf6e6,
  cartMetal: 0xb8bec4,
  cartOrange: 0xe8763a,
  pole: 0x8d949b,
} as const

export const TRAIN = {
  wall: 0xbfe0dc,
  wallDark: 0x9dc7c3,
  floor: 0xa9cfca,
  seat: 0x8ec6c1,
  pole: 0xe6f3f1,
  lamp: 0xfffbe0,
  sky: 0xd6ecfa,
  cloud: 0xffffff,
} as const
