export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL_: 0x05,
  OBJECT_IDENTIFIER: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x10,
} as const;

export type TagNumber = (typeof Tag)[keyof typeof Tag];

export const TAG_NAMES: Record<number, string> = {
  [Tag.BOOLEAN]: 'BOOLEAN',
  [Tag.INTEGER]: 'INTEGER',
  [Tag.BIT_STRING]: 'BIT STRING',
  [Tag.OCTET_STRING]: 'OCTET STRING',
  [Tag.NULL_]: 'NULL',
  [Tag.OBJECT_IDENTIFIER]: 'OBJECT IDENTIFIER',
  [Tag.UTF8_STRING]: 'UTF8String',
  [Tag.SEQUENCE]: 'SEQUENCE',
};

export const SUPPORTED_PRIMITIVE_TAGS = new Set<number>([
  Tag.BOOLEAN,
  Tag.INTEGER,
  Tag.BIT_STRING,
  Tag.OCTET_STRING,
  Tag.NULL_,
  Tag.OBJECT_IDENTIFIER,
  Tag.UTF8_STRING,
]);
