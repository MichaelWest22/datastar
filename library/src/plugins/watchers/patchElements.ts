// Icon: material-symbols:cloud-download
// Slug: Patches elements into the DOM.
// Description: Patches elements into the DOM.

import { watcher } from '@engine'
import type { WatcherContext } from '@engine/types'
import { isHTMLOrSVG } from '@utils/dom'
import { aliasify } from '@utils/text'
import { supportsViewTransitions } from '@utils/view-transitions'

const isValidType = <T extends readonly string[]>(
  arr: T,
  value: string,
): value is T[number] => (arr as readonly string[]).includes(value)

const PATCH_MODES = [
  'remove',
  'outer',
  'inner',
  'replace',
  'prepend',
  'append',
  'before',
  'after',
] as const
type PatchElementsMode = (typeof PATCH_MODES)[number]

const NAMESPACES = ['html', 'svg', 'mathml'] as const
type Namespace = (typeof NAMESPACES)[number]

type PatchElementsArgs = {
  selector: string
  mode: PatchElementsMode
  namespace: Namespace
  useViewTransition: boolean
  elements: string
}

watcher({
  name: 'datastar-patch-elements',
  apply(
    ctx,
    {
      selector = '',
      mode = 'outer',
      namespace = 'html',
      useViewTransition = '',
      elements = '',
    },
  ) {
    if (!isValidType(PATCH_MODES, mode)) {
      throw ctx.error('PatchElementsInvalidMode', { mode })
    }

    if (!selector && mode !== 'outer' && mode !== 'replace') {
      throw ctx.error('PatchElementsExpectedSelector')
    }

    if (!isValidType(NAMESPACES, namespace)) {
      throw ctx.error('PatchElementsInvalidNamespace', { namespace })
    }

    const args2: PatchElementsArgs = {
      selector,
      mode,
      namespace,
      useViewTransition: useViewTransition.trim() === 'true',
      elements,
    }

    if (supportsViewTransitions && useViewTransition) {
      document.startViewTransition(() => onPatchElements(ctx, args2))
    } else {
      onPatchElements(ctx, args2)
    }
  },
})

const onPatchElements = (
  { error }: WatcherContext,
  { selector, mode, namespace, elements }: PatchElementsArgs,
) => {
  const elementsWithSvgsRemoved = elements.replace(
    /<svg(\s[^>]*>|>)([\s\S]*?)<\/svg>/gim,
    '',
  )
  const hasHtml = /<\/html>/.test(elementsWithSvgsRemoved)
  const hasHead = /<\/head>/.test(elementsWithSvgsRemoved)
  const hasBody = /<\/body>/.test(elementsWithSvgsRemoved)

  const wrapperTag =
    namespace === 'svg' ? 'svg' : namespace === 'mathml' ? 'math' : ''
  const wrappedEls = wrapperTag
    ? `<${wrapperTag}>${elements}</${wrapperTag}>`
    : elements

  const newDocument = new DOMParser().parseFromString(
    hasHtml || hasHead || hasBody
      ? elements
      : `<body><template>${wrappedEls}</template></body>`,
    'text/html',
  )

  let newContent = document.createDocumentFragment()
  if (hasHtml) {
    newContent.appendChild(newDocument.documentElement)
  } else if (hasHead && hasBody) {
    newContent.appendChild(newDocument.head)
    newContent.appendChild(newDocument.body)
  } else if (hasHead) {
    newContent.appendChild(newDocument.head)
  } else if (hasBody) {
    newContent.appendChild(newDocument.body)
  } else if (wrapperTag) {
    const wrapperEl = newDocument
      .querySelector('template')!
      .content.querySelector(wrapperTag)!
    for (const child of wrapperEl.childNodes) {
      newContent.appendChild(child)
    }
  } else {
    newContent = newDocument.querySelector('template')!.content
  }

  if (!selector && (mode === 'outer' || mode === 'replace')) {
    for (const child of newContent.children) {
      let target: Element
      if (child instanceof HTMLHtmlElement) {
        target = document.documentElement
      } else if (child instanceof HTMLBodyElement) {
        target = document.body
      } else if (child instanceof HTMLHeadElement) {
        target = document.head
      } else {
        target = document.getElementById(child.id)!
        if (!target) {
          console.warn(error('PatchElementsNoTargetsFound'), {
            element: { id: child.id },
          })
          continue
        }
      }

      applyToTargets(mode as PatchElementsMode, child, [target])
    }
  } else {
    const targets = document.querySelectorAll(selector)
    if (!targets.length) {
      console.warn(error('PatchElementsNoTargetsFound'), { selector })
      return
    }

    applyToTargets(mode as PatchElementsMode, newContent, targets)
  }
}

const scripts = new WeakSet<HTMLScriptElement>()
for (const script of document.querySelectorAll('script')) {
  scripts.add(script)
}

const execute = (target: Element): void => {
  const elScripts =
    target instanceof HTMLScriptElement
      ? [target]
      : target.querySelectorAll('script')
  for (const old of elScripts) {
    if (!scripts.has(old)) {
      const script = document.createElement('script')
      for (const { name, value } of old.attributes) {
        script.setAttribute(name, value)
      }
      script.text = old.text
      old.replaceWith(script)
      scripts.add(script)
    }
  }
}

const applyPatchMode = (
  targets: Iterable<Element>,
  element: DocumentFragment | Element,
  action: string,
) => {
  for (const target of targets) {
    const cloned = element.cloneNode(true) as Element
    execute(cloned)
    // @ts-expect-error
    target[action](cloned)
  }
}

const applyToTargets = (
  mode: PatchElementsMode,
  element: DocumentFragment | Element,
  targets: Iterable<Element>,
) => {
  switch (mode) {
    case 'remove':
      for (const target of targets) {
        target.remove()
      }
      break
    case 'outer':
    case 'inner':
      for (const target of targets) {
        morph(target, element.cloneNode(true) as Element, mode)
        execute(target)
      }
      break
    case 'replace':
      applyPatchMode(targets, element, 'replaceWith')
      break
    case 'prepend':
    case 'append':
    case 'before':
    case 'after':
      applyPatchMode(targets, element, mode)
  }
}

let ctxFutureMatches = new WeakSet<Node>()
let ctxActiveElementAndParents: Element[] = []

const aliasedIgnoreMorph = aliasify('ignore-morph')
const aliasedIgnoreMorphAttr = `[${aliasedIgnoreMorph}]`
const morph = (
  oldElt: Element | ShadowRoot,
  newContent: DocumentFragment | Element,
  mode: 'outer' | 'inner' = 'outer',
): void => {
  if (
    (isHTMLOrSVG(oldElt) &&
      isHTMLOrSVG(newContent) &&
      oldElt.hasAttribute(aliasedIgnoreMorph) &&
      newContent.hasAttribute(aliasedIgnoreMorph)) ||
    oldElt.parentElement?.closest(aliasedIgnoreMorphAttr)
  ) {
    return
  }

  const normalizedElt = document.createElement('div')
  normalizedElt.append(newContent)

  ctxFutureMatches = new WeakSet()
  ctxActiveElementAndParents = []
  let elt = document.activeElement
  while (elt !== oldElt) {
    if (!elt) break
    ctxActiveElementAndParents.push(elt)
    elt = elt.parentElement
  }

  const parent = mode === 'outer' ? oldElt.parentElement! : oldElt
  morphChildren(
    parent,
    normalizedElt,
    mode === 'outer' ? oldElt : null,
    oldElt.nextSibling,
  )
}

const morphChildren = (
  oldParent: Element | ShadowRoot, // the old content that we are merging the new content into
  newParent: Element, // the parent element of the new content
  insertionPoint: Node | null = null, // the point in the DOM we start morphing at (defaults to first child)
  endPoint: Node | null = null, // the point in the DOM we stop morphing at (defaults to after last child)
): void => {
  // normalize
  if (
    oldParent instanceof HTMLTemplateElement &&
    newParent instanceof HTMLTemplateElement
  ) {
    // we can pretend the DocumentElement is an Element
    oldParent = oldParent.content as unknown as Element
    newParent = newParent.content as unknown as Element
  }
  insertionPoint ??= oldParent.firstChild

  // run through all the new content
  for (const newChild of newParent.childNodes) {
    // once we reach the end of the old parent content skip to the end and insert the rest
    if (insertionPoint && insertionPoint !== endPoint) {
      const bestMatch = findBestMatch(newChild, insertionPoint, endPoint)
      if (bestMatch) {
        // if the node to morph is not at the insertion point then remove/move up to it
        if (bestMatch !== insertionPoint) {
          moveNodesBetweenToEnd(
            oldParent,
            insertionPoint,
            bestMatch,
            endPoint,
            newChild,
          )
        }
        morphNode(bestMatch, newChild)
        insertionPoint = bestMatch.nextSibling
        continue
      }
    }

    const newClonedChild = document.importNode(newChild, true)
    oldParent.insertBefore(newClonedChild, insertionPoint)
    insertionPoint = newClonedChild.nextSibling
  }

  while (insertionPoint && insertionPoint !== endPoint) {
    const tempNode = insertionPoint
    insertionPoint = insertionPoint.nextSibling
    removeNode(tempNode)
  }
}

const isMatch = (oldNode: Node, newNode: Node): boolean => {
  if (oldNode.isEqualNode(newNode)) return true
  if (oldNode instanceof Element && newNode instanceof Element) {
    const attrs = ['id', 'name', 'href', 'src']
    for (const attr of attrs) {
      const v1 = oldNode.getAttribute(attr)
      const v2 = newNode.getAttribute(attr)
      if (v1 && v1 === v2) return true
    }
  }
  return false
}

const matchesUpcomingSibling = (
  oldNode: Node,
  startNode: Node,
  limit = 50,
): boolean => {
  if (ctxFutureMatches.has(oldNode)) return true
  for (
    let sibling = startNode.nextSibling, i = 0;
    sibling && i < limit;
    sibling = sibling.nextSibling, i++
  ) {
    if (isMatch(oldNode, sibling)) {
      ctxFutureMatches.add(oldNode)
      return true
    }
  }
  return false
}

const isSoftMatch = (oldNode: Node, newNode: Node): boolean =>
  oldNode.nodeType === newNode.nodeType &&
  (oldNode as Element).tagName === (newNode as Element).tagName

const findBestMatch = (
  node: Node,
  startPoint: Node | null,
  endPoint: Node | null,
): Node | null => {
  if (node.nodeType !== 1) {
    return startPoint?.nodeType === node.nodeType ? startPoint : null
  }

  let softMatch: Node | null = null
  let cursor = startPoint

  while (cursor && cursor !== endPoint) {
    if (isSoftMatch(cursor, node)) {
      if (isMatch(cursor, node)) return cursor
      if (!softMatch) softMatch = cursor
    }
    if (ctxActiveElementAndParents.includes(cursor as Element)) break
    cursor = cursor.nextSibling
  }

  if (softMatch && matchesUpcomingSibling(softMatch, node)) return null
  return softMatch
}

const removeNode = (node: Node): void => {
  node.parentNode?.removeChild(node)
}

const moveNodesBetweenToEnd = (
  oldParent: Element | ShadowRoot,
  startInclusive: Node,
  endExclusive: Node,
  originalEndPoint: Node | null,
  currentNewChild: Node,
): void => {
  let cursor: Node | null = startInclusive
  while (cursor && cursor !== endExclusive) {
    const tempNode = cursor
    cursor = cursor.nextSibling
    if (
      tempNode instanceof Element &&
      matchesUpcomingSibling(tempNode, currentNewChild)
    ) {
      moveBefore(oldParent, tempNode, originalEndPoint)
    } else {
      removeNode(tempNode)
    }
  }
}

const moveBefore = (
  parentNode: Node,
  node: Node,
  after: Node | null,
): void => {
  // @ts-expect-error
  if (parentNode.moveBefore) {
    try {
      // @ts-expect-error
      parentNode.moveBefore(node, after)
    } catch {
      parentNode.insertBefore(node, after)
    }
  } else {
    parentNode.insertBefore(node, after)
  }
}

const aliasedPreserveAttr = aliasify('preserve-attr')

// syncs the oldNode to the newNode, copying over all attributes and
// inner element state from the newNode to the oldNode
const morphNode = (
  oldNode: Node, // root node to merge content into
  newNode: Node, // new content to merge
): Node => {
  const type = newNode.nodeType

  // if is an element type, sync the attributes from the
  // new node into the new node
  if (type === 1 /* element type */) {
    const oldElt = oldNode as Element
    const newElt = newNode as Element
    const shouldScopeChildren = oldElt.hasAttribute('data-scope-children')
    if (
      oldElt.hasAttribute(aliasedIgnoreMorph) &&
      newElt.hasAttribute(aliasedIgnoreMorph)
    ) {
      return oldNode
    }

    //  many bothans died to bring us this information:
    //  https://github.com/patrick-steele-idem/morphdom/blob/master/src/specialElHandlers.js
    //  https://github.com/choojs/nanomorph/blob/master/lib/morph.js#L113
    if (
      oldElt instanceof HTMLInputElement &&
      newElt instanceof HTMLInputElement &&
      newElt.type !== 'file'
    ) {
      // https://github.com/bigskysoftware/idiomorph/issues/27
      // | old input value | new input value  | behaviour                              |
      // | --------------- | ---------------- | -------------------------------------- |
      // | `null`          | `null`           | preserve old input value               |
      // | some value      | the same value   | preserve old input value               |
      // | some value      | `null`           | set old input value to `""`            |
      // | `null`          | some value       | set old input value to new input value |
      // | some value      | some other value | set old input value to new input value |
      if (newElt.getAttribute('value') !== oldElt.getAttribute('value')) {
        oldElt.value = newElt.getAttribute('value') ?? ''
      }
    } else if (
      oldElt instanceof HTMLTextAreaElement &&
      newElt instanceof HTMLTextAreaElement
    ) {
      if (newElt.value !== oldElt.value) {
        oldElt.value = newElt.value
      }
      if (oldElt.firstChild && oldElt.firstChild.nodeValue !== newElt.value) {
        oldElt.firstChild.nodeValue = newElt.value
      }
    }

    const preserveAttrs = (
      (newNode as HTMLElement).getAttribute(aliasedPreserveAttr) ?? ''
    ).split(' ')

    for (const { name, value } of newElt.attributes) {
      if (
        oldElt.getAttribute(name) !== value &&
        !preserveAttrs.includes(name)
      ) {
        oldElt.setAttribute(name, value)
      }
    }

    for (let i = oldElt.attributes.length - 1; i >= 0; i--) {
      const { name } = oldElt.attributes[i]!
      if (!newElt.hasAttribute(name) && !preserveAttrs.includes(name)) {
        oldElt.removeAttribute(name)
      }
    }

    // Preserve the scope marker even if the incoming markup doesn't carry it.
    if (shouldScopeChildren && !oldElt.hasAttribute('data-scope-children')) {
      oldElt.setAttribute('data-scope-children', '')
    }

    if (!oldElt.isEqualNode(newElt)) {
      morphChildren(oldElt, newElt)
    }

    if (shouldScopeChildren) {
      oldElt.dispatchEvent(
        new CustomEvent('datastar:scope-children', { bubbles: false }),
      )
    }
  }

  if (type === 8 /* comment */ || type === 3 /* text */) {
    if (oldNode.nodeValue !== newNode.nodeValue) {
      oldNode.nodeValue = newNode.nodeValue
    }
  }

  return oldNode
}
