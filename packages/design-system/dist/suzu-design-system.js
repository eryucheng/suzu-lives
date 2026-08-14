import { Fragment as e, jsx as t, jsxs as n } from "react/jsx-runtime";
import { forwardRef as r, useCallback as i, useEffect as a, useRef as o, useState as s } from "react";
var c = {
	button: "_button_goqwv_3",
	"size-sm": "_size-sm_goqwv_16",
	"size-md": "_size-md_goqwv_17",
	"size-lg": "_size-lg_goqwv_18",
	"variant-primary": "_variant-primary_goqwv_21",
	"variant-secondary": "_variant-secondary_goqwv_33",
	"variant-ghost": "_variant-ghost_goqwv_43",
	"variant-danger": "_variant-danger_goqwv_52"
};
//#endregion
//#region src/components/Button/Button.tsx
function l({ variant: e = "primary", size: n = "md", className: r, type: i = "button", children: a, ...o }) {
	let s = [
		c.button,
		c[`variant-${e}`],
		c[`size-${n}`],
		r
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("button", {
		type: i,
		className: s,
		...o,
		children: a
	});
}
var u = {
	panel: "_panel_19ax7_3",
	"intensity-subtle": "_intensity-subtle_19ax7_13",
	"intensity-soft": "_intensity-soft_19ax7_16",
	"intensity-prominent": "_intensity-prominent_19ax7_19"
};
//#endregion
//#region src/components/Glass/GlassPanel.tsx
function d({ as: e = "div", intensity: n = "soft", className: r, style: i, children: a }) {
	let o = [
		u.panel,
		u[`intensity-${n}`],
		r
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t(e, {
		className: o,
		style: i,
		children: a
	});
}
var f = {
	overlay: "_overlay_m5h1d_3",
	"fade-in": "_fade-in_m5h1d_1",
	dialog: "_dialog_m5h1d_15",
	"pop-in": "_pop-in_m5h1d_1",
	header: "_header_m5h1d_49",
	title: "_title_m5h1d_58",
	close: "_close_m5h1d_64",
	body: "_body_m5h1d_81",
	footer: "_footer_m5h1d_89"
};
//#endregion
//#region src/components/Dialog/Dialog.tsx
function p({ open: e, onClose: r, title: i, children: o, footer: s }) {
	return a(() => {
		if (!e) return;
		let t = (e) => {
			e.key === "Escape" && r();
		};
		return document.addEventListener("keydown", t), () => document.removeEventListener("keydown", t);
	}, [e, r]), e ? /* @__PURE__ */ t("div", {
		className: f.overlay,
		onMouseDown: r,
		children: /* @__PURE__ */ n("div", {
			role: "dialog",
			"aria-modal": "true",
			"aria-label": typeof i == "string" ? i : void 0,
			className: f.dialog,
			onMouseDown: (e) => e.stopPropagation(),
			children: [
				i != null && /* @__PURE__ */ n("div", {
					className: f.header,
					children: [/* @__PURE__ */ t("h2", {
						className: f.title,
						children: i
					}), /* @__PURE__ */ t("button", {
						type: "button",
						"aria-label": "关闭",
						className: f.close,
						onClick: r,
						children: "×"
					})]
				}),
				/* @__PURE__ */ t("div", {
					className: f.body,
					children: o
				}),
				s != null && /* @__PURE__ */ t("div", {
					className: f.footer,
					children: s
				})
			]
		})
	}) : null;
}
var m = {
	overlay: "_overlay_16wol_3",
	"fade-in": "_fade-in_16wol_1",
	drawer: "_drawer_16wol_11",
	"slide-right": "_slide-right_16wol_1",
	"placement-left": "_placement-left_16wol_44",
	"slide-left": "_slide-left_16wol_1",
	"placement-right": "_placement-right_16wol_51",
	header: "_header_16wol_59",
	title: "_title_16wol_68",
	close: "_close_16wol_74",
	body: "_body_16wol_91"
};
//#endregion
//#region src/components/Drawer/Drawer.tsx
function h({ open: e, onClose: r, placement: i = "right", title: o, children: s }) {
	if (a(() => {
		if (!e) return;
		let t = (e) => {
			e.key === "Escape" && r();
		};
		return document.addEventListener("keydown", t), () => document.removeEventListener("keydown", t);
	}, [e, r]), !e) return null;
	let c = [m.drawer, i === "left" ? m["placement-left"] : m["placement-right"]].join(" ");
	return /* @__PURE__ */ t("div", {
		className: m.overlay,
		onMouseDown: r,
		children: /* @__PURE__ */ n("aside", {
			role: "dialog",
			"aria-modal": "true",
			"aria-label": typeof o == "string" ? o : void 0,
			className: c,
			onMouseDown: (e) => e.stopPropagation(),
			children: [/* @__PURE__ */ n("div", {
				className: m.header,
				children: [/* @__PURE__ */ t("h2", {
					className: m.title,
					children: o
				}), /* @__PURE__ */ t("button", {
					type: "button",
					"aria-label": "关闭",
					className: m.close,
					onClick: r,
					children: "×"
				})]
			}), /* @__PURE__ */ t("div", {
				className: m.body,
				children: s
			})]
		})
	});
}
var g = {
	pill: "_pill_pdt89_3",
	"tone-success": "_tone-success_pdt89_24",
	"tone-warning": "_tone-warning_pdt89_25",
	"tone-danger": "_tone-danger_pdt89_26",
	"tone-info": "_tone-info_pdt89_27",
	"tone-muted": "_tone-muted_pdt89_28"
};
//#endregion
//#region src/components/Status/Status.tsx
function _({ label: e, tone: n = "muted" }) {
	return /* @__PURE__ */ t("span", {
		className: [g.pill, g[`tone-${n}`]].join(" "),
		children: e
	});
}
var v = {
	switch: "_switch_ormz1_3",
	track: "_track_ormz1_17"
}, y = r(function({ checked: e, className: r, ...i }, a) {
	return /* @__PURE__ */ n("label", {
		className: [v.switch, r].filter(Boolean).join(" "),
		children: [/* @__PURE__ */ t("input", {
			ref: a,
			type: "checkbox",
			checked: e,
			...i
		}), /* @__PURE__ */ t("span", { className: v.track })]
	});
}), b = {
	wrapper: "_wrapper_bplya_3",
	input: "_input_bplya_10",
	"size-sm": "_size-sm_bplya_36",
	"size-md": "_size-md_bplya_37",
	"size-lg": "_size-lg_bplya_38",
	"has-prefix": "_has-prefix_bplya_41",
	"has-suffix": "_has-suffix_bplya_42",
	affix: "_affix_bplya_44",
	prefix: "_prefix_bplya_53",
	suffix: "_suffix_bplya_54"
}, x = r(function({ prefix: e, suffix: r, size: i = "md", className: a, style: o, ...s }, c) {
	let l = [
		b.input,
		b[`size-${i}`],
		e != null && b["has-prefix"],
		r != null && b["has-suffix"],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("span", {
		className: b.wrapper,
		style: o,
		children: [
			e != null && /* @__PURE__ */ t("span", {
				className: [b.affix, b.prefix].join(" "),
				children: e
			}),
			/* @__PURE__ */ t("input", {
				ref: c,
				className: l,
				...s
			}),
			r != null && /* @__PURE__ */ t("span", {
				className: [b.affix, b.suffix].join(" "),
				children: r
			})
		]
	});
}), S = {
	wrapper: "_wrapper_n35bl_3",
	fullWidth: "_fullWidth_n35bl_9",
	trigger: "_trigger_n35bl_14",
	open: "_open_n35bl_43",
	placeholder: "_placeholder_n35bl_48",
	label: "_label_n35bl_52",
	chevron: "_chevron_n35bl_59",
	chevronOpen: "_chevronOpen_n35bl_67",
	panel: "_panel_n35bl_72",
	"pop-in": "_pop-in_n35bl_1",
	option: "_option_n35bl_109",
	active: "_active_n35bl_128",
	selected: "_selected_n35bl_134",
	check: "_check_n35bl_139",
	disabled: "_disabled_n35bl_163"
};
//#endregion
//#region src/components/Select/Select.tsx
function C({ options: e, value: r, defaultValue: c, onChange: l, placeholder: u = "请选择", disabled: d = !1, fullWidth: f = !1, id: p, className: m }) {
	let [h, g] = s(!1), [_, v] = s(c ?? ""), [y, b] = s(-1), x = o(null), C = r === void 0 ? _ : r, w = e.find((e) => e.value === C);
	a(() => {
		if (!h) return;
		let e = (e) => {
			x.current && !x.current.contains(e.target) && g(!1);
		}, t = (e) => {
			e.key === "Escape" && g(!1);
		};
		return document.addEventListener("mousedown", e), document.addEventListener("keydown", t), () => {
			document.removeEventListener("mousedown", e), document.removeEventListener("keydown", t);
		};
	}, [h]), a(() => {
		h && b(e.findIndex((e) => e.value === C));
	}, [h]);
	let T = i((e) => {
		g(!1), b(-1), r === void 0 && v(e), l?.(e);
	}, [r, l]), E = (t) => {
		if (!d) {
			if ((t.key === "ArrowDown" || t.key === "ArrowUp") && !h) {
				t.preventDefault(), g(!0);
				return;
			}
			if (h) {
				if (t.key === "ArrowDown" || t.key === "ArrowUp") {
					t.preventDefault();
					let n = t.key === "ArrowDown" ? 1 : -1;
					b((t) => ((t < 0 ? -n : t) + n + e.length) % e.length);
				} else t.key === "Enter" && y >= 0 ? (t.preventDefault(), T(e[y].value)) : t.key === "Home" ? (t.preventDefault(), b(0)) : t.key === "End" && (t.preventDefault(), b(e.length - 1));
			}
		}
	}, D = [
		S.wrapper,
		f && S.fullWidth,
		d && S.disabled,
		m
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("div", {
		ref: x,
		className: D,
		children: [/* @__PURE__ */ n("button", {
			id: p,
			type: "button",
			className: [S.trigger, h && S.open].filter(Boolean).join(" "),
			onClick: () => !d && g((e) => !e),
			onKeyDown: E,
			"aria-haspopup": "listbox",
			"aria-expanded": h,
			"aria-disabled": d,
			disabled: d,
			children: [w ? /* @__PURE__ */ t("span", {
				className: S.label,
				children: w.label
			}) : /* @__PURE__ */ t("span", {
				className: S.placeholder,
				children: u
			}), /* @__PURE__ */ t("svg", {
				className: [S.chevron, h && S.chevronOpen].filter(Boolean).join(" "),
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: /* @__PURE__ */ t("path", {
					d: "M4 6l4 4 4-4",
					stroke: "currentColor",
					strokeWidth: "1.8",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			})]
		}), h && !d && /* @__PURE__ */ t("div", {
			className: S.panel,
			role: "listbox",
			children: e.map((e, r) => {
				let i = e.value === C;
				return /* @__PURE__ */ n("button", {
					type: "button",
					role: "option",
					"aria-selected": i,
					className: [
						S.option,
						i && S.selected,
						r === y && S.active
					].filter(Boolean).join(" "),
					onClick: () => T(e.value),
					onMouseEnter: () => b(r),
					children: [e.label, /* @__PURE__ */ t("svg", {
						className: S.check,
						viewBox: "0 0 16 16",
						fill: "none",
						"aria-hidden": "true",
						children: /* @__PURE__ */ t("path", {
							d: "M3 8.5L6.5 12 13 4.5",
							stroke: "currentColor",
							strokeWidth: "1.8",
							strokeLinecap: "round",
							strokeLinejoin: "round"
						})
					})]
				}, e.value);
			})
		})]
	});
}
var w = { textarea: "_textarea_1qdhy_3" }, T = r(function({ className: e, style: n, ...r }, i) {
	return /* @__PURE__ */ t("textarea", {
		ref: i,
		className: [w.textarea, e].filter(Boolean).join(" "),
		style: n,
		...r
	});
}), E = {
	header: "_header_q4k7s_3",
	copy: "_copy_q4k7s_12",
	eyebrow: "_eyebrow_q4k7s_16",
	title: "_title_q4k7s_24",
	subtitle: "_subtitle_q4k7s_32",
	action: "_action_q4k7s_40"
};
//#endregion
//#region src/components/PageHeader/PageHeader.tsx
function D({ eyebrow: e, title: r, subtitle: i, action: a, className: o }) {
	return /* @__PURE__ */ n("div", {
		className: [E.header, o].filter(Boolean).join(" "),
		children: [/* @__PURE__ */ n("div", {
			className: E.copy,
			children: [
				e != null && /* @__PURE__ */ t("div", {
					className: E.eyebrow,
					children: e
				}),
				/* @__PURE__ */ t("h1", {
					className: E.title,
					children: r
				}),
				i != null && /* @__PURE__ */ t("p", {
					className: E.subtitle,
					children: i
				})
			]
		}), a != null && /* @__PURE__ */ t("div", {
			className: E.action,
			children: a
		})]
	});
}
var O = {
	avatar: "_avatar_mdjkl_3",
	initial: "_initial_mdjkl_23",
	"size-sm": "_size-sm_mdjkl_29",
	"size-md": "_size-md_mdjkl_30",
	"size-lg": "_size-lg_mdjkl_31",
	"size-xl": "_size-xl_mdjkl_32"
};
//#endregion
//#region src/components/Avatar/Avatar.tsx
function k({ src: e, name: n, size: r = "md", fallback: i, className: a, style: o }) {
	let s = String(n).trim().slice(0, 1).toUpperCase(), c = [
		O.avatar,
		O[`size-${r}`],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("span", {
		className: c,
		style: o,
		"aria-label": n,
		role: "img",
		children: e ? /* @__PURE__ */ t("img", {
			src: e,
			alt: "",
			draggable: !1
		}) : /* @__PURE__ */ t("span", {
			className: O.initial,
			children: i ?? s
		})
	});
}
var A = {
	banner: "_banner_j1jux_3",
	icon: "_icon_j1jux_14",
	body: "_body_j1jux_21",
	"tone-warning": "_tone-warning_j1jux_27",
	"tone-info": "_tone-info_j1jux_32",
	"tone-danger": "_tone-danger_j1jux_37",
	"tone-success": "_tone-success_j1jux_42",
	"tone-neutral": "_tone-neutral_j1jux_47"
};
//#endregion
//#region src/components/Banner/Banner.tsx
function ee({ tone: e = "neutral", icon: r, children: i, className: a, style: o }) {
	let s = [
		A.banner,
		A[`tone-${e}`],
		a
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("div", {
		className: s,
		style: o,
		role: e === "danger" ? "alert" : "status",
		children: [r != null && /* @__PURE__ */ t("span", {
			className: A.icon,
			children: r
		}), /* @__PURE__ */ t("div", {
			className: A.body,
			children: i
		})]
	});
}
var j = {
	card: "_card_1oylx_3",
	header: "_header_1oylx_13",
	copy: "_copy_1oylx_21",
	title: "_title_1oylx_25",
	description: "_description_1oylx_33",
	action: "_action_1oylx_40",
	body: "_body_1oylx_44"
};
//#endregion
//#region src/components/Card/Card.tsx
function te({ title: e, description: r, action: i, children: a, className: o, style: s }) {
	let c = [j.card, o].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("article", {
		className: c,
		style: s,
		children: [e != null && /* @__PURE__ */ n("div", {
			className: j.header,
			children: [/* @__PURE__ */ n("div", {
				className: j.copy,
				children: [/* @__PURE__ */ t("h3", {
					className: j.title,
					children: e
				}), r != null && /* @__PURE__ */ t("p", {
					className: j.description,
					children: r
				})]
			}), i != null && /* @__PURE__ */ t("div", {
				className: j.action,
				children: i
			})]
		}), /* @__PURE__ */ t("div", {
			className: j.body,
			children: a
		})]
	});
}
var M = {
	wrap: "_wrap_1o6wz_4",
	message: "_message_1o6wz_11",
	user: "_user_1o6wz_19",
	avatar: "_avatar_1o6wz_23",
	bubble: "_bubble_1o6wz_27",
	live: "_live_1o6wz_62",
	mediaOnly: "_mediaOnly_1o6wz_69",
	text: "_text_1o6wz_76",
	meta: "_meta_1o6wz_84",
	time: "_time_1o6wz_91",
	timeline: "_timeline_1o6wz_99"
};
//#endregion
//#region src/components/ChatBubble/ChatBubble.tsx
function N({ align: r = "left", avatar: i, meta: a, time: o, timeInline: s = !1, live: c = !1, mediaOnly: l = !1, children: u, className: d, style: f }) {
	let p = [
		M.message,
		r === "right" && M.user,
		c && M.live,
		l && M.mediaOnly,
		d
	].filter(Boolean).join(" "), m = /* @__PURE__ */ n(e, { children: [i != null && /* @__PURE__ */ t("div", {
		className: M.avatar,
		children: i
	}), /* @__PURE__ */ n("div", {
		className: M.bubble,
		children: [
			a != null && /* @__PURE__ */ t("div", {
				className: M.meta,
				children: a
			}),
			/* @__PURE__ */ t("div", {
				className: M.text,
				children: u
			}),
			o != null && s && /* @__PURE__ */ t("div", {
				className: M.time,
				children: o
			})
		]
	})] });
	return o != null && !s ? /* @__PURE__ */ n("div", {
		className: M.wrap,
		style: f,
		children: [/* @__PURE__ */ t("div", {
			className: M.timeline,
			children: o
		}), /* @__PURE__ */ t("div", {
			className: p,
			children: m
		})]
	}) : /* @__PURE__ */ t("div", {
		className: p,
		style: f,
		children: m
	});
}
var P = {
	composer: "_composer_1t2r5_4",
	surface: "_surface_1t2r5_14",
	textarea: "_textarea_1t2r5_26",
	footer: "_footer_1t2r5_58",
	tools: "_tools_1t2r5_59",
	submitArea: "_submitArea_1t2r5_60",
	tool: "_tool_1t2r5_59",
	staticTool: "_staticTool_1t2r5_76",
	isActive: "_isActive_1t2r5_93",
	sendButton: "_sendButton_1t2r5_123"
};
//#endregion
//#region src/components/ChatComposer/ChatComposer.tsx
function F({ placeholder: r = "输入消息（Enter 发送；Shift+Enter 换行）", onSend: i, disabled: a = !1, maxLength: o = 2e4, tools: c, className: l, style: u }) {
	let [d, f] = s(""), p = !a && d.trim().length > 0, m = () => {
		p && (i?.(d.trim()), f(""));
	};
	return /* @__PURE__ */ t("div", {
		className: [P.composer, l].filter(Boolean).join(" "),
		style: u,
		children: /* @__PURE__ */ n("div", {
			className: P.surface,
			children: [/* @__PURE__ */ t("textarea", {
				className: P.textarea,
				value: d,
				rows: 3,
				maxLength: o,
				placeholder: r,
				disabled: a,
				onChange: (e) => f(e.target.value),
				onKeyDown: (e) => {
					e.key === "Enter" && !e.shiftKey && (e.preventDefault(), m());
				}
			}), /* @__PURE__ */ n("div", {
				className: P.footer,
				children: [/* @__PURE__ */ t("div", {
					className: P.tools,
					"aria-label": "聊天工具",
					children: c ?? /* @__PURE__ */ n(e, { children: [
						/* @__PURE__ */ t("button", {
							type: "button",
							className: P.tool,
							"aria-label": "表情",
							title: "表情",
							disabled: a,
							children: /* @__PURE__ */ t(ne, {})
						}),
						/* @__PURE__ */ t("span", {
							className: P.staticTool,
							title: "附件",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(re, {})
						}),
						/* @__PURE__ */ t("span", {
							className: P.staticTool,
							title: "文件",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(ie, {})
						}),
						/* @__PURE__ */ t("span", {
							className: P.staticTool,
							title: "截图",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(ae, {})
						}),
						/* @__PURE__ */ t("span", {
							className: P.staticTool,
							title: "语音输入",
							"aria-hidden": "true",
							children: /* @__PURE__ */ t(oe, {})
						})
					] })
				}), /* @__PURE__ */ n("div", {
					className: P.submitArea,
					children: [/* @__PURE__ */ t("span", {
						className: P.staticTool,
						title: "语音消息",
						"aria-hidden": "true",
						children: /* @__PURE__ */ t(se, {})
					}), /* @__PURE__ */ t("button", {
						type: "button",
						className: P.sendButton,
						onClick: m,
						disabled: !p,
						children: "发送"
					})]
				})]
			})]
		})
	});
}
var I = {
	display: "block",
	width: 21,
	height: 21
}, L = (e, n) => /* @__PURE__ */ t("svg", {
	viewBox: "0 0 24 24",
	className: e,
	style: I,
	"aria-hidden": "true",
	children: n
});
function ne({ className: r }) {
	return L(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("circle", {
		cx: "12",
		cy: "12",
		r: "8.3"
	}), /* @__PURE__ */ t("path", { d: "M8.4 14.2c.9 1.2 2.1 1.8 3.6 1.8s2.7-.6 3.6-1.8M9 9.5h.01M15 9.5h.01" })] }));
}
function re({ className: r }) {
	return L(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("path", { d: "m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z" }), /* @__PURE__ */ t("path", { d: "m4 7.4 8 4.4 8-4.4M12 11.8V21" })] }));
}
function ie({ className: e }) {
	return L(e, /* @__PURE__ */ t("path", { d: "M3.5 7.2h6l1.9 2h9.1v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" }));
}
function ae({ className: r }) {
	return L(r, /* @__PURE__ */ n(e, { children: [
		/* @__PURE__ */ t("circle", {
			cx: "6.4",
			cy: "17.2",
			r: "2.2"
		}),
		/* @__PURE__ */ t("circle", {
			cx: "6.4",
			cy: "6.8",
			r: "2.2"
		}),
		/* @__PURE__ */ t("path", { d: "m8.2 8.2 10.3 7.1M8.2 15.8l4-2.8" })
	] }));
}
function oe({ className: r }) {
	return L(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("rect", {
		x: "8.5",
		y: "3",
		width: "7",
		height: "12",
		rx: "3.5"
	}), /* @__PURE__ */ t("path", { d: "M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M8.5 21h7" })] }));
}
function se({ className: r }) {
	return L(r, /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("path", { d: "M4 14h3.2L12 18V6L7.2 10H4v4Z" }), /* @__PURE__ */ t("path", { d: "M15 9.2a4.2 4.2 0 0 1 0 5.6M17.8 6.4a8.1 8.1 0 0 1 0 11.2" })] }));
}
var R = {
	file: "_file_15x0e_3",
	fileRow: "_fileRow_15x0e_17",
	fileIcon: "_fileIcon_15x0e_25",
	copy: "_copy_15x0e_37",
	kind: "_kind_15x0e_44",
	name: "_name_15x0e_49",
	size: "_size_15x0e_58"
};
//#endregion
//#region src/components/ChatFile/ChatFile.tsx
function z({ name: e, size: r, label: i = "文件", onClick: a, className: o }) {
	return /* @__PURE__ */ t("div", {
		role: "button",
		tabIndex: 0,
		className: [R.file, o].filter(Boolean).join(" "),
		onClick: a,
		onKeyDown: (e) => {
			(e.key === "Enter" || e.key === " ") && a && (e.preventDefault(), a());
		},
		children: /* @__PURE__ */ n("div", {
			className: R.fileRow,
			children: [/* @__PURE__ */ t("div", {
				className: R.fileIcon,
				children: /* @__PURE__ */ t(B, {})
			}), /* @__PURE__ */ n("div", {
				className: R.copy,
				children: [
					/* @__PURE__ */ t("span", {
						className: R.kind,
						children: i
					}),
					/* @__PURE__ */ t("strong", {
						className: R.name,
						children: e
					}),
					r != null && /* @__PURE__ */ t("span", {
						className: R.size,
						children: r
					})
				]
			})]
		})
	});
}
function B() {
	return /* @__PURE__ */ n("svg", {
		viewBox: "0 0 16 16",
		width: "17",
		height: "17",
		fill: "none",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ t("path", {
				d: "M3 1.5h6l4 4v9h-10v-13z",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round"
			}),
			/* @__PURE__ */ t("path", {
				d: "M9 1.5v4h4",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round"
			}),
			/* @__PURE__ */ t("path", {
				d: "M5.5 9h5M5.5 11.5h3",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			})
		]
	});
}
var V = {
	preview: "_preview_6l9bb_4",
	image: "_image_6l9bb_18",
	overlay: "_overlay_6l9bb_32",
	dialog: "_dialog_6l9bb_43",
	dialogHead: "_dialogHead_6l9bb_57",
	dialogTitle: "_dialogTitle_6l9bb_66",
	close: "_close_6l9bb_86",
	stage: "_stage_6l9bb_107",
	dialogImg: "_dialogImg_6l9bb_117",
	nav: "_nav_6l9bb_126",
	dialogFoot: "_dialogFoot_6l9bb_153",
	jump: "_jump_6l9bb_160"
};
//#endregion
//#region src/components/ChatImage/ChatImage.tsx
function H({ src: r, alt: i = "", name: a, gallery: o, onJump: c, className: l }) {
	let [u, d] = s(!1), [f, p] = s(0), m = o && o.length > 0 ? o : [{
		src: r,
		name: a,
		key: void 0,
		messageId: void 0
	}], h = m[f] ?? m[0], g = m.length;
	return /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("button", {
		type: "button",
		className: [V.preview, l].filter(Boolean).join(" "),
		onClick: () => {
			let e = o && o.length > 0 ? Math.max(0, o.findIndex((e) => e.src === r)) : 0;
			p(e === -1 ? 0 : e), d(!0);
		},
		"aria-label": "放大查看图片",
		children: /* @__PURE__ */ t("img", {
			className: V.image,
			src: r,
			alt: i,
			loading: "lazy",
			draggable: !1
		})
	}), u && /* @__PURE__ */ t("div", {
		className: V.overlay,
		onClick: () => d(!1),
		children: /* @__PURE__ */ n("section", {
			className: V.dialog,
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "图片预览",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ n("header", {
					className: V.dialogHead,
					children: [/* @__PURE__ */ n("div", {
						className: V.dialogTitle,
						children: [/* @__PURE__ */ t("strong", { children: h?.name || "图片" }), /* @__PURE__ */ n("span", { children: [
							f + 1,
							" / ",
							g
						] })]
					}), /* @__PURE__ */ t("button", {
						type: "button",
						className: V.close,
						onClick: () => d(!1),
						"aria-label": "关闭图片预览",
						children: "×"
					})]
				}),
				/* @__PURE__ */ n("div", {
					className: V.stage,
					children: [
						/* @__PURE__ */ t("button", {
							type: "button",
							className: V.nav,
							onClick: () => p((e) => Math.max(0, e - 1)),
							disabled: f <= 0,
							"aria-label": "上一张",
							children: "‹"
						}),
						/* @__PURE__ */ t("img", {
							className: V.dialogImg,
							src: h?.src,
							alt: i
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: V.nav,
							onClick: () => p((e) => Math.min(g - 1, e + 1)),
							disabled: f >= g - 1,
							"aria-label": "下一张",
							children: "›"
						})
					]
				}),
				/* @__PURE__ */ t("footer", {
					className: V.dialogFoot,
					children: /* @__PURE__ */ t("button", {
						type: "button",
						className: V.jump,
						onClick: () => c?.(h),
						children: "跳转到图片所在位置"
					})
				})
			]
		})
	})] });
}
var U = {
	voice: "_voice_1ct04_3",
	toggle: "_toggle_1ct04_18",
	toggleIcon: "_toggleIcon_1ct04_40",
	iconPlay: "_iconPlay_1ct04_46",
	content: "_content_1ct04_51",
	wave: "_wave_1ct04_58",
	bar: "_bar_1ct04_66",
	playing: "_playing_1ct04_77",
	"voice-pulse": "_voice-pulse_1ct04_1",
	meta: "_meta_1ct04_100",
	progress: "_progress_1ct04_107",
	progressFill: "_progressFill_1ct04_115",
	time: "_time_1ct04_122"
}, W = [
	35,
	62,
	46,
	84,
	56,
	92,
	48,
	74,
	39,
	66,
	45,
	78
], G = 170, ce = 320;
function le(e) {
	return Math.min(ce, Math.max(G, 150 + e * 2.2));
}
var ue = 14;
function de(e) {
	let t = (e - G) / 150;
	return Math.round(ue + 12 * t);
}
function fe(e) {
	let t = Math.floor(e / 60), n = Math.floor(e % 60);
	return `${t}:${String(n).padStart(2, "0")}`;
}
function pe(e) {
	return Math.max(0, Math.round(e));
}
function me({ duration: r = 0, progress: i, playing: a, onToggle: o, className: c, style: l }) {
	let [u, d] = s(!1), [f, p] = s(0), m = pe(r), h = a === void 0 ? u : a, g = i === void 0 ? f : i, _ = le(m), v = Array.from({ length: de(_) }, (e, t) => W[t % W.length]), y = () => {
		let e = !h;
		if (a === void 0) {
			if (d(e), e) {
				let e = setInterval(() => {
					p((t) => t >= 100 ? (clearInterval(e), d(!1), 100) : Math.min(100, t + 2));
				}, 200);
				return;
			}
			p(0);
		}
		o?.(e);
	}, b = [
		U.voice,
		h && U.playing,
		c
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("div", {
		className: b,
		style: {
			...l,
			width: _
		},
		children: [/* @__PURE__ */ t("button", {
			type: "button",
			className: U.toggle,
			onClick: y,
			"aria-label": h ? "暂停" : "播放",
			children: /* @__PURE__ */ t("svg", {
				className: U.toggleIcon,
				viewBox: "0 0 14 14",
				fill: "currentColor",
				"aria-hidden": "true",
				children: h ? /* @__PURE__ */ n(e, { children: [/* @__PURE__ */ t("rect", {
					x: "3",
					y: "2",
					width: "3",
					height: "10",
					rx: "1"
				}), /* @__PURE__ */ t("rect", {
					x: "8",
					y: "2",
					width: "3",
					height: "10",
					rx: "1"
				})] }) : /* @__PURE__ */ t("path", {
					className: U.iconPlay,
					d: "M4 2.2v9.6a.5.5 0 0 0 .77.42l7.4-4.8a.5.5 0 0 0 0-.84l-7.4-4.8a.5.5 0 0 0-.77.42z"
				})
			})
		}), /* @__PURE__ */ n("div", {
			className: U.content,
			children: [/* @__PURE__ */ t("div", {
				className: U.wave,
				children: v.map((e, n) => /* @__PURE__ */ t("i", {
					className: U.bar,
					style: { "--voice-bar-height": `${e}%` }
				}, n))
			}), /* @__PURE__ */ n("div", {
				className: U.meta,
				children: [/* @__PURE__ */ t("div", {
					className: U.progress,
					children: /* @__PURE__ */ t("span", {
						className: U.progressFill,
						style: { width: `${g}%` }
					})
				}), /* @__PURE__ */ t("span", {
					className: U.time,
					children: fe(m)
				})]
			})]
		})]
	});
}
var K = {
	nav: "_nav_y6idz_1",
	item: "_item_y6idz_9",
	active: "_active_y6idz_33",
	itemActive: "_itemActive_y6idz_34",
	icon: "_icon_y6idz_44",
	label: "_label_y6idz_60"
};
//#endregion
//#region src/components/SideNav/SideNav.tsx
function he({ children: e, className: n, style: r }) {
	return /* @__PURE__ */ t("nav", {
		className: [K.nav, n].filter(Boolean).join(" "),
		style: r,
		children: e
	});
}
function ge({ active: e = !1, icon: r, onClick: i, children: a, className: o }) {
	let s = [
		K.item,
		e && K.itemActive,
		o
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("button", {
		type: "button",
		className: s,
		onClick: i,
		"aria-current": e ? "page" : void 0,
		children: [r != null && /* @__PURE__ */ t("span", {
			className: K.icon,
			children: r
		}), /* @__PURE__ */ t("span", {
			className: K.label,
			children: a
		})]
	});
}
var q = {
	row: "_row_11muq_3",
	interactive: "_interactive_11muq_19",
	icon: "_icon_11muq_23",
	copy: "_copy_11muq_44",
	title: "_title_11muq_49",
	description: "_description_11muq_61",
	action: "_action_11muq_72"
};
//#endregion
//#region src/components/ListRow/ListRow.tsx
function _e({ icon: e, title: r, description: i, action: a, interactive: o = !0, onClick: s, className: c }) {
	let l = [
		q.row,
		o && q.interactive,
		c
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n(o ? "button" : "div", {
		type: o ? "button" : void 0,
		className: l,
		onClick: o ? s : void 0,
		children: [
			e != null && /* @__PURE__ */ t("span", {
				className: q.icon,
				children: e
			}),
			/* @__PURE__ */ n("span", {
				className: q.copy,
				children: [/* @__PURE__ */ t("span", {
					className: q.title,
					children: r
				}), i != null && /* @__PURE__ */ t("span", {
					className: q.description,
					children: i
				})]
			}),
			a != null && /* @__PURE__ */ t("span", {
				className: q.action,
				children: a
			})
		]
	});
}
var J = {
	row: "_row_1hgcr_3",
	selected: "_selected_1hgcr_24",
	rowActive: "_rowActive_1hgcr_25",
	avatar: "_avatar_1hgcr_30",
	copy: "_copy_1hgcr_34",
	name: "_name_1hgcr_39",
	subtitle: "_subtitle_1hgcr_50",
	meta: "_meta_1hgcr_60"
};
//#endregion
//#region src/components/Roster/Roster.tsx
function Y({ avatar: e, name: r, subtitle: i, meta: a, selected: o = !1, onClick: s, className: c }) {
	let l = [
		J.row,
		o && J.rowActive,
		c
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ n("button", {
		type: "button",
		className: l,
		onClick: s,
		"aria-pressed": o,
		children: [
			/* @__PURE__ */ t("span", {
				className: J.avatar,
				children: e
			}),
			/* @__PURE__ */ n("span", {
				className: J.copy,
				children: [/* @__PURE__ */ t("span", {
					className: J.name,
					children: r
				}), i != null && /* @__PURE__ */ t("span", {
					className: J.subtitle,
					children: i
				})]
			}),
			a != null && /* @__PURE__ */ t("span", {
				className: J.meta,
				children: a
			})
		]
	});
}
var X = {
	tabs: "_tabs_18548_3",
	fullWidth: "_fullWidth_18548_17",
	tab: "_tab_18548_3",
	active: "_active_18548_43",
	tabActive: "_tabActive_18548_44",
	"size-md": "_size-md_18548_56",
	"size-lg": "_size-lg_18548_57"
};
//#endregion
//#region src/components/Tabs/Tabs.tsx
function ve({ items: e, active: r, onChange: i, size: a = "sm", fullWidth: o = !1, className: s }) {
	let c = [
		X.tabs,
		o && X.fullWidth,
		s
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ t("div", {
		className: c,
		role: "tablist",
		children: e.map((e) => {
			let t = e.value === r;
			return /* @__PURE__ */ n("button", {
				type: "button",
				role: "tab",
				"aria-selected": t,
				className: [
					X.tab,
					X[`size-${a}`],
					t && X.tabActive
				].filter(Boolean).join(" "),
				onClick: () => i?.(e.value),
				children: [e.icon, e.label]
			}, e.value);
		})
	});
}
var Z = {
	panel: "_panel_17dvf_3",
	symbol: "_symbol_17dvf_16",
	title: "_title_17dvf_37",
	description: "_description_17dvf_44",
	action: "_action_17dvf_52"
};
//#endregion
//#region src/components/Empty/Empty.tsx
function ye({ icon: e, title: r, description: i, action: a, className: o, style: s }) {
	return /* @__PURE__ */ n("div", {
		className: [Z.panel, o].filter(Boolean).join(" "),
		style: s,
		children: [
			e != null && /* @__PURE__ */ t("div", {
				className: Z.symbol,
				children: e
			}),
			/* @__PURE__ */ t("h3", {
				className: Z.title,
				children: r
			}),
			i != null && /* @__PURE__ */ t("p", {
				className: Z.description,
				children: i
			}),
			a != null && /* @__PURE__ */ t("div", {
				className: Z.action,
				children: a
			})
		]
	});
}
var Q = {
	scroll: "_scroll_1klg4_3",
	table: "_table_1klg4_7",
	header: "_header_1klg4_14",
	cell: "_cell_1klg4_25",
	row: "_row_1klg4_35",
	"align-right": "_align-right_1klg4_39",
	striped: "_striped_1klg4_44"
};
//#endregion
//#region src/components/Table/Table.tsx
function be({ columns: e, data: r, striped: i = !1, className: a, style: o }) {
	return /* @__PURE__ */ t("div", {
		className: [Q.scroll, a].filter(Boolean).join(" "),
		style: o,
		children: /* @__PURE__ */ n("table", {
			className: [Q.table, i && Q.striped].filter(Boolean).join(" "),
			children: [/* @__PURE__ */ t("thead", { children: /* @__PURE__ */ t("tr", { children: e.map((e) => /* @__PURE__ */ t("th", {
				className: [Q.header, e.align === "right" && Q["align-right"]].filter(Boolean).join(" "),
				style: {
					width: e.width == null ? void 0 : e.width,
					textAlign: e.align
				},
				children: e.label
			}, e.key)) }) }), /* @__PURE__ */ t("tbody", { children: r.map((n, r) => /* @__PURE__ */ t("tr", {
				className: Q.row,
				children: e.map((e) => /* @__PURE__ */ t("td", {
					className: [Q.cell, e.align === "right" && Q["align-right"]].filter(Boolean).join(" "),
					style: { textAlign: e.align },
					children: e.render ? e.render(n) : String(n[e.key] ?? "")
				}, e.key))
			}, r)) })]
		})
	});
}
var $ = {
	board: "_board_ogm3w_3",
	"layout-fill": "_layout-fill_ogm3w_8",
	head: "_head_ogm3w_15",
	title: "_title_ogm3w_22",
	controls: "_controls_ogm3w_29",
	navButton: "_navButton_ogm3w_35",
	todayButton: "_todayButton_ogm3w_55",
	iconButton: "_iconButton_ogm3w_74",
	weekdays: "_weekdays_ogm3w_90",
	grid: "_grid_ogm3w_91",
	"grid-fill": "_grid-fill_ogm3w_117",
	day: "_day_ogm3w_124",
	blank: "_blank_ogm3w_125",
	today: "_today_ogm3w_1",
	dayToday: "_dayToday_ogm3w_156",
	selected: "_selected_ogm3w_161",
	daySelected: "_daySelected_ogm3w_162",
	dots: "_dots_ogm3w_173",
	dot: "_dot_ogm3w_173",
	holiday: "_holiday_ogm3w_190",
	dotHoliday: "_dotHoliday_ogm3w_191"
};
//#endregion
//#region src/components/Calendar/Calendar.tsx
function xe({ year: e, month: r, events: i = {}, selected: a, onSelect: o, onPrevMonth: s, onNextMonth: c, onGoToday: l, controls: u, weekdayLabels: d = [
	"一",
	"二",
	"三",
	"四",
	"五",
	"六",
	"日"
], layout: f = "content", className: p }) {
	let m = d.length === 7 ? d : [
		"一",
		"二",
		"三",
		"四",
		"五",
		"六",
		"日"
	], h = (new Date(e, r, 1).getDay() + 6) % 7, g = new Date(e, r + 1, 0).getDate(), _ = /* @__PURE__ */ new Date(), v = `${_.getFullYear()}-${String(_.getMonth() + 1).padStart(2, "0")}-${String(_.getDate()).padStart(2, "0")}`, y = (e) => String(e).padStart(2, "0"), b = (t) => `${e}-${y(r + 1)}-${y(t)}`, x = [];
	for (let e = 0; e < h; e++) x.push(/* @__PURE__ */ t("span", {
		className: $.blank,
		"aria-hidden": !0
	}, `b${e}`));
	for (let e = 1; e <= g; e++) {
		let r = b(e), s = r === v, c = r === a, l = i[r] ?? [];
		x.push(/* @__PURE__ */ n("button", {
			type: "button",
			className: [
				$.day,
				s && $.dayToday,
				c && $.daySelected
			].filter(Boolean).join(" "),
			onClick: () => o?.(r),
			children: [/* @__PURE__ */ t("span", { children: e }), l.length > 0 && /* @__PURE__ */ t("i", {
				className: $.dots,
				children: l.map((e, n) => /* @__PURE__ */ t("b", { className: [$.dot, e === "holiday" && $.dotHoliday].filter(Boolean).join(" ") }, n))
			})]
		}, r));
	}
	let S = `${e} 年 ${r + 1} 月`;
	return /* @__PURE__ */ n("div", {
		className: [
			$.board,
			f === "fill" && $["layout-fill"],
			p
		].filter(Boolean).join(" "),
		children: [
			/* @__PURE__ */ n("div", {
				className: $.head,
				children: [/* @__PURE__ */ t("h4", {
					className: $.title,
					children: S
				}), /* @__PURE__ */ n("div", {
					className: $.controls,
					children: [
						u,
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.navButton,
							onClick: s,
							"aria-label": "上一月",
							children: "‹"
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.todayButton,
							onClick: l,
							children: "今天"
						}),
						/* @__PURE__ */ t("button", {
							type: "button",
							className: $.navButton,
							onClick: c,
							"aria-label": "下一月",
							children: "›"
						})
					]
				})]
			}),
			/* @__PURE__ */ t("div", {
				className: $.weekdays,
				children: m.map((e) => /* @__PURE__ */ t("span", { children: e }, e))
			}),
			/* @__PURE__ */ t("div", {
				className: [$.grid, f === "fill" && $["grid-fill"]].filter(Boolean).join(" "),
				children: x
			})
		]
	});
}
//#endregion
export { k as Avatar, ee as Banner, l as Button, xe as Calendar, te as Card, N as ChatBubble, F as ChatComposer, z as ChatFile, H as ChatImage, me as ChatVoice, p as Dialog, h as Drawer, ye as Empty, d as GlassPanel, x as Input, _e as ListRow, D as PageHeader, Y as Roster, C as Select, he as SideNav, ge as SideNavItem, _ as Status, y as Switch, be as Table, ve as Tabs, T as Textarea };
