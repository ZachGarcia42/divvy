// Shows a receipt. A saved photo is fetched with the sign-in token (native Image can send headers); a just-picked one is a local file.
import { Image, type ImageStyle, type StyleProp } from 'react-native'
import type { ReceiptSource } from './flows/photo'

export function PhotoImage({ source, style, resizeMode = 'cover', testID, label }: {
  source: ReceiptSource; style?: StyleProp<ImageStyle>; resizeMode?: 'cover' | 'contain'; testID?: string; label: string
}) {
  const uri = source.kind === 'remote' ? { uri: source.url, headers: source.headers } : { uri: source.uri }
  return <Image source={uri} style={style} resizeMode={resizeMode} accessibilityLabel={label} testID={testID} />
}
