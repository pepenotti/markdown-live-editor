# Footnotes, sizes and references

Footnotes are numbered in the order they are first used[^second], whatever they are called[^1]. A second use of the same note[^second] keeps its number, and an undefined one [^missing] stays as text.

Inline math such as $a^2 + b^2 = c^2$ and a [reference link][spec] can be edited from the popover in full preview.

![Hills at dusk](assets/photo.png)
*A caption on the next line.*

A reference image: ![Diagram][diagram] and an HTML one: <img src="assets/diagram.svg" alt="small diagram" width="120">

[^1]: The first definition, with *emphasis* and a [link](https://example.com).
[^second]: The second definition
continues on the next line.
[^unused]: Nothing points here.

[spec]: https://spec.commonmark.org/
[diagram]: assets/diagram.svg
