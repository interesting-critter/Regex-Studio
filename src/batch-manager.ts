export interface BatchFieldItem {
  id: string
  characterId: string
  characterName: string
  key: string
  label: string
  sublabel?: string
  value: string
}

export interface CharacterPatchUpdate {
  id: string
  name: string
  patch: Record<string, any>
}

export function buildBatchCharacterFields(
  characters: any[],
  enabledFields: Set<string>,
  charFieldDefs: readonly { key: string; label: string }[]
): BatchFieldItem[] {
  const fields: BatchFieldItem[] = []

  characters.forEach((char) => {
    charFieldDefs.forEach((f) => {
      if (!enabledFields.has(f.key)) return

      if (f.key === 'alternate_greetings') {
        const altGreetings: string[] = Array.isArray(char.alternate_greetings)
          ? char.alternate_greetings
          : []
        altGreetings.forEach((greeting, idx) => {
          fields.push({
            id: `${char.id}_alt_greeting_${idx}`,
            characterId: char.id,
            characterName: char.name,
            key: 'alternate_greetings',
            label: `${char.name} — Alt Greeting ${idx + 1}`,
            sublabel: `Card: ${char.name}`,
            value: (greeting || '').replace(/\r\n/g, '\n'),
          })
        })
      } else {
        fields.push({
          id: `${char.id}_${f.key}`,
          characterId: char.id,
          characterName: char.name,
          key: f.key,
          label: `${char.name} — ${f.label}`,
          sublabel: `Card: ${char.name}`,
          value: (char[f.key] || '').replace(/\r\n/g, '\n'),
        })
      }
    })
  })

  return fields
}

export function assembleBatchPatches(
  fields: BatchFieldItem[],
  enabledFields: Set<string>
): CharacterPatchUpdate[] {
  const cardsMap = new Map<string, { name: string; patch: Record<string, any>; altGreetings: string[] }>()

  fields.forEach((f) => {
    if (!cardsMap.has(f.characterId)) {
      cardsMap.set(f.characterId, {
        name: f.characterName,
        patch: {},
        altGreetings: [],
      })
    }
    const cardData = cardsMap.get(f.characterId)!

    if (f.key === 'alternate_greetings') {
      cardData.altGreetings.push(f.value)
    } else {
      cardData.patch[f.key] = f.value
    }
  })

  const updates: CharacterPatchUpdate[] = []
  cardsMap.forEach((data, id) => {
    if (enabledFields.has('alternate_greetings')) {
      data.patch.alternate_greetings = data.altGreetings
    }
    updates.push({
      id,
      name: data.name,
      patch: data.patch,
    })
  })

  return updates
}