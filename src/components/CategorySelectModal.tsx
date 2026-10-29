"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "./Modal";
import { CATEGORIES } from "@/data/categories";

interface CategorySelectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CategorySelectModal({ open, onOpenChange }: CategorySelectModalProps) {
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  const handleContinue = () => {
    onOpenChange(false);
    router.push("/early-access");
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Select Job Category"
    >
      <div className="space-y-5 -mt-2">
        <div>
          <label htmlFor="category-select" className="sr-only">
            Select Job Category
          </label>
          <select
            id="category-select"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="w-full h-12 px-3.5 bg-white border border-[#E4E4E7] rounded-lg text-base text-[#09090B] focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent cursor-pointer shadow-sm"
          >
            <option value="">Select Job Category</option>
            {CATEGORIES.map((cat) => (
              <option key={cat.id} value={cat.slug}>
                {cat.name} ({cat.count.toLocaleString()} jobs)
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleContinue}
          className="w-full h-12 bg-black text-white font-semibold rounded-lg hover:bg-neutral-800 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2 flex items-center justify-center cursor-pointer shadow-sm"
        >
          Continue to Job Search
        </button>
      </div>
    </Modal>
  );
}
