"use client";

import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
};

/** Auth-sheet password field (same 48px / #F7F8F9 styling as the email input) with a show/hide toggle. */
export default function PasswordInput({ id, value, onChange, autoComplete, placeholder = "Password", describedBy, invalid }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        required
        className="w-full h-[48px] min-h-[48px] rounded-[8px] border border-[#E5E7EB] bg-[#F7F8F9] pl-4 pr-12 text-[14px] text-[#0F172A] placeholder-[#9CA3AF] transition-all focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD] focus:bg-white focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={id}
        className="absolute right-0 top-0 h-[48px] w-[48px] flex items-center justify-center text-[#64748B] hover:text-[#0F172A] rounded-[8px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
      >
        {visible ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
