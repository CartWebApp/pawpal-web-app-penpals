export interface Fragment {
    type: 'Fragment';
    nodes: Array<RegularElement | Text | Component | Comment>;
}

export interface BaseElement {
    type: string;
    void_element: boolean;
    name: string;
    attrs: Record<string, string | true>;
    fragment: Fragment;
}

export interface RegularElement extends BaseElement {
    type: 'RegularElement';
}

export interface Text {
    type: 'Text';
    content: string;
}

export interface Comment {
    type: 'Comment';
    content: string;
}

export interface Component extends BaseElement {
    type: 'Component';
}

export interface Root {
    type: 'Root';
    fragment: Fragment;
}

export type Node =
    | RegularElement
    | Text
    | Component
    | Root
    | Comment
    | Fragment;

export interface Options {
    components?: string[];
}
